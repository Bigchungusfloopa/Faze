"""
Pipeline extractors
--------------------
Each function takes a RoutingDecision and returns a list of RawChunk objects
in a *common schema*, regardless of which pipeline produced them. This is
what lets the retriever treat text/table/scanned/image content uniformly
later, while still preserving the provenance (page, section, chunk_type)
needed for evidence-based responses.
"""

from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional, Sequence

import csv
from pathlib import Path

import fitz
import pdfplumber

from .router import PipelineType, RoutingDecision


@dataclass
class RawChunk:
    text: str
    doc_id: str
    filename: str
    page_num: Optional[int]
    chunk_type: str  # "text" | "table" | "ocr" | "image_caption"
    section: Optional[str] = None
    extra: dict = field(default_factory=dict)


# Type alias for the Gemini vision callback the caller must supply for
# scanned PDFs and images (kept out of this module so extractors.py has
# no hard dependency on the LLM client -> easy to unit test).
VisionFn = Callable[[bytes, str], str]  # (image_bytes, prompt) -> transcribed text


def extract_text_pdf(decision: RoutingDecision, doc_id: str) -> List[RawChunk]:
    filename = decision.file_path.split("/")[-1]
    chunks = []
    doc = fitz.open(decision.file_path)
    for page_num, page in enumerate(doc, start=1):
        text = str(page.get_text("text")).strip()
        if not text:
            continue
        # crude section header guess: first short bold-looking line
        section = None
        page_dict: Any = page.get_text("dict")
        blocks = page_dict.get("blocks", []) if isinstance(page_dict, dict) else []
        for b in blocks:
            for line in b.get("lines", []):
                for span in line.get("spans", []):
                    if span.get("size", 0) >= 13 and len(span.get("text", "").strip()) > 0:
                        section = span["text"].strip()
                        break
                if section:
                    break
            if section:
                break
        chunks.append(RawChunk(
            text=text,
            doc_id=doc_id,
            filename=filename,
            page_num=page_num,
            chunk_type="text",
            section=section,
        ))
    doc.close()
    return chunks


def extract_table_pdf(decision: RoutingDecision, doc_id: str) -> List[RawChunk]:
    """Handles PDFs that are table-dominant. Falls back to prose text too,
    so nothing on the page is lost."""
    filename = decision.file_path.split("/")[-1]
    chunks = []
    with pdfplumber.open(decision.file_path) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            tables = page.extract_tables()
            for t_idx, table in enumerate(tables):
                md_table = _table_to_markdown(table)
                if md_table.strip():
                    chunks.append(RawChunk(
                        text=md_table,
                        doc_id=doc_id,
                        filename=filename,
                        page_num=page_num,
                        chunk_type="table",
                        section=f"table_{t_idx+1}",
                    ))
            # also capture any prose not part of a table
            prose = page.extract_text() or ""
            if prose.strip():
                chunks.append(RawChunk(
                    text=prose.strip(),
                    doc_id=doc_id,
                    filename=filename,
                    page_num=page_num,
                    chunk_type="text",
                ))
    return chunks


def extract_scanned_pdf(decision: RoutingDecision, doc_id: str, vision_fn: VisionFn) -> List[RawChunk]:
    """Renders each page to an image and hands it to the vision_fn (Gemini
    multimodal in production, mock in tests) for transcription."""
    filename = decision.file_path.split("/")[-1]
    chunks = []
    doc = fitz.open(decision.file_path)
    prompt = (
        "Transcribe all readable text from this scanned document page exactly "
        "as it appears. If the page is illegible or blank, respond with "
        "'[NO TEXT DETECTED]'. Do not summarize, do not add commentary."
    )
    for page_num, page in enumerate(doc, start=1):
        pix = page.get_pixmap(dpi=200)
        img_bytes = pix.tobytes("png")
        transcribed = vision_fn(img_bytes, prompt).strip()
        if transcribed and transcribed != "[NO TEXT DETECTED]":
            chunks.append(RawChunk(
                text=transcribed,
                doc_id=doc_id,
                filename=filename,
                page_num=page_num,
                chunk_type="ocr",
            ))
    doc.close()
    return chunks


def extract_image(decision: RoutingDecision, doc_id: str, vision_fn: VisionFn) -> List[RawChunk]:
    filename = decision.file_path.split("/")[-1]
    with open(decision.file_path, "rb") as f:
        img_bytes = f.read()
    prompt = (
        "Describe this image factually and transcribe any visible text "
        "verbatim. Do not speculate about anything not visibly present."
    )
    description = vision_fn(img_bytes, prompt).strip()
    if not description:
        return []
    return [RawChunk(
        text=description,
        doc_id=doc_id,
        filename=filename,
        page_num=1,
        chunk_type="image_caption",
    )]


def extract_csv(decision: RoutingDecision, doc_id: str) -> List[RawChunk]:
    filename = Path(decision.file_path).name
    chunks = []
    rows = []
    for enc in ["utf-8", "utf-8-sig", "latin-1", "cp1252"]:
        try:
            with open(decision.file_path, "r", encoding=enc) as f:
                reader = csv.reader(f)
                rows = [row for row in reader if any(cell.strip() for cell in row)]
            break
        except Exception:
            continue

    if not rows:
        return []

    header = rows[0]
    body = rows[1:]

    if not body:
        table_md = _table_to_markdown([header])
        return [RawChunk(
            text=table_md,
            doc_id=doc_id,
            filename=filename,
            page_num=1,
            chunk_type="table",
            section="CSV Headers",
        )]

    chunk_size_rows = 25
    for idx, i in enumerate(range(0, len(body), chunk_size_rows), start=1):
        batch = [header] + body[i:i + chunk_size_rows]
        table_md = _table_to_markdown(batch)
        start_row = i + 1
        end_row = min(i + chunk_size_rows, len(body))
        chunks.append(RawChunk(
            text=table_md,
            doc_id=doc_id,
            filename=filename,
            page_num=idx,
            chunk_type="table",
            section=f"Rows {start_row}-{end_row} of {len(body)}",
        ))
    return chunks


def extract_excel(decision: RoutingDecision, doc_id: str) -> List[RawChunk]:
    import openpyxl  # type: ignore
    filename = Path(decision.file_path).name
    chunks = []
    wb = openpyxl.load_workbook(decision.file_path, data_only=True)
    page_counter = 1

    for sheet_name in wb.sheetnames:
        sheet = wb[sheet_name]
        all_rows = []
        for row in sheet.iter_rows(values_only=True):
            str_row = [str(val).strip() if val is not None else "" for val in row]
            if any(str_row):
                all_rows.append(str_row)

        if not all_rows:
            continue

        header = all_rows[0]
        body = all_rows[1:]

        if not body:
            table_md = _table_to_markdown([header])
            chunks.append(RawChunk(
                text=f"### Sheet: {sheet_name}\n" + table_md,
                doc_id=doc_id,
                filename=filename,
                page_num=page_counter,
                chunk_type="table",
                section=f"Sheet: {sheet_name}",
            ))
            page_counter += 1
            continue

        chunk_size_rows = 25
        for i in range(0, len(body), chunk_size_rows):
            batch = [header] + body[i:i + chunk_size_rows]
            table_md = _table_to_markdown(batch)
            start_row = i + 1
            end_row = min(i + chunk_size_rows, len(body))
            chunks.append(RawChunk(
                text=f"### Sheet: {sheet_name}\n" + table_md,
                doc_id=doc_id,
                filename=filename,
                page_num=page_counter,
                chunk_type="table",
                section=f"Sheet: {sheet_name} (Rows {start_row}-{end_row})",
            ))
            page_counter += 1

    wb.close()
    return chunks


def _extract_raw_strings(file_path: str, min_len: int = 4) -> str:
    """Fallback text extractor for legacy binary formats (like older .doc or .ppt)."""
    try:
        with open(file_path, "rb") as f:
            raw = f.read()
        import re
        matches = re.findall(rb"[\x20-\x7E\t\n\r]{" + str(min_len).encode() + rb",}", raw)
        decoded = [m.decode("latin-1", errors="ignore").strip() for m in matches]
        return "\n".join(d for d in decoded if len(d) > 3)
    except Exception:
        return ""


def extract_docx(decision: RoutingDecision, doc_id: str) -> List[RawChunk]:
    import docx  # type: ignore
    import docx.table  # type: ignore
    import docx.text.paragraph  # type: ignore
    filename = Path(decision.file_path).name
    try:
        doc = docx.Document(decision.file_path)
    except Exception:
        raw_text = _extract_raw_strings(decision.file_path)
        if raw_text:
            return [RawChunk(
                text=raw_text[:4000],
                doc_id=doc_id,
                filename=filename,
                page_num=1,
                chunk_type="text",
                section="Document Content",
            )]
        return []

    chunks = []

    current_section = "Document Content"
    current_text_lines = []
    page_counter = 1

    for element in doc.element.body:
        tag = element.tag.split("}")[-1]
        if tag == "p":
            para = docx.text.paragraph.Paragraph(element, doc)
            text = para.text.strip()
            if not text:
                continue
            style_name = getattr(para.style, "name", None)
            if style_name and str(style_name).startswith("Heading"):
                if current_text_lines:
                    chunks.append(RawChunk(
                        text="\n\n".join(current_text_lines),
                        doc_id=doc_id,
                        filename=filename,
                        page_num=page_counter,
                        chunk_type="text",
                        section=current_section,
                    ))
                    page_counter += 1
                    current_text_lines = []
                current_section = text
            else:
                current_text_lines.append(text)
                if sum(len(line) for line in current_text_lines) >= 900:
                    chunks.append(RawChunk(
                        text="\n\n".join(current_text_lines),
                        doc_id=doc_id,
                        filename=filename,
                        page_num=page_counter,
                        chunk_type="text",
                        section=current_section,
                    ))
                    page_counter += 1
                    current_text_lines = []
        elif tag == "tbl":
            table = docx.table.Table(element, doc)
            table_rows = []
            for row in table.rows:
                table_rows.append([cell.text.strip() for cell in row.cells])
            if table_rows:
                table_md = _table_to_markdown(table_rows)
                chunks.append(RawChunk(
                    text=table_md,
                    doc_id=doc_id,
                    filename=filename,
                    page_num=page_counter,
                    chunk_type="table",
                    section=f"{current_section} (Table)",
                ))
                page_counter += 1

    if current_text_lines:
        chunks.append(RawChunk(
            text="\n\n".join(current_text_lines),
            doc_id=doc_id,
            filename=filename,
            page_num=page_counter,
            chunk_type="text",
            section=current_section,
        ))
    return chunks


def extract_text_doc(decision: RoutingDecision, doc_id: str) -> List[RawChunk]:
    filename = Path(decision.file_path).name
    chunks = []
    text = ""
    for enc in ["utf-8", "utf-8-sig", "latin-1", "cp1252"]:
        try:
            with open(decision.file_path, "r", encoding=enc, errors="replace") as f:
                text = f.read()
            break
        except Exception:
            continue

    if not text.strip():
        return []

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    current_lines = []
    current_section = "General"
    page_counter = 1

    for p in paragraphs:
        if p.startswith("#"):
            lines = p.splitlines()
            current_section = lines[0].lstrip("#").strip()

        current_lines.append(p)
        if sum(len(line) for line in current_lines) >= 900:
            chunks.append(RawChunk(
                text="\n\n".join(current_lines),
                doc_id=doc_id,
                filename=filename,
                page_num=page_counter,
                chunk_type="text",
                section=current_section,
            ))
            page_counter += 1
            current_lines = []

    if current_lines:
        chunks.append(RawChunk(
            text="\n\n".join(current_lines),
            doc_id=doc_id,
            filename=filename,
            page_num=page_counter,
            chunk_type="text",
            section=current_section,
        ))
    return chunks


def _table_to_markdown(table: Sequence[Sequence[Any]]) -> str:
    if not table:
        return ""
    rows = [[str(c) if c is not None else "" for c in row] for row in table]
    header, *body = rows
    md = "| " + " | ".join(header) + " |\n"
    md += "| " + " | ".join(["---"] * len(header)) + " |\n"
    for row in body:
        md += "| " + " | ".join(row) + " |\n"
    return md


def extract_presentation(decision: RoutingDecision, doc_id: str) -> List[RawChunk]:
    """Extracts structured slides, text frames, tables, and notes from PowerPoint presentations (.pptx, .ppt)."""
    filename = Path(decision.file_path).name
    chunks = []
    try:
        from pptx import Presentation  # type: ignore
        prs = Presentation(decision.file_path)
        for slide_num, slide in enumerate(prs.slides, start=1):
            slide_title = ""
            title_shape = getattr(slide.shapes, "title", None)
            if title_shape and getattr(title_shape, "text", None):
                slide_title = title_shape.text.strip()

            slide_lines = []
            tables_md = []

            for shape_obj in slide.shapes:
                shape: Any = shape_obj
                if getattr(shape, "has_table", False):
                    tbl_rows = []
                    for row in shape.table.rows:
                        tbl_rows.append([cell.text.strip() for cell in row.cells])
                    if tbl_rows:
                        tables_md.append(_table_to_markdown(tbl_rows))
                elif getattr(shape, "has_text_frame", False):
                    for para in shape.text_frame.paragraphs:
                        text = para.text.strip()
                        if text and text != slide_title:
                            slide_lines.append(text)

            notes_text = ""
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
                notes = slide.notes_slide.notes_text_frame.text.strip()
                if notes:
                    notes_text = f"Speaker Notes: {notes}"

            content_parts = []
            if slide_title:
                content_parts.append(f"## Slide {slide_num}: {slide_title}")
            else:
                content_parts.append(f"## Slide {slide_num}")

            if slide_lines:
                content_parts.append("\n".join(slide_lines))
            if tables_md:
                content_parts.extend(tables_md)
            if notes_text:
                content_parts.append(notes_text)

            combined_text = "\n\n".join(content_parts).strip()
            if combined_text:
                chunks.append(RawChunk(
                    text=combined_text,
                    doc_id=doc_id,
                    filename=filename,
                    page_num=slide_num,
                    chunk_type="presentation",
                    section=slide_title or f"Slide {slide_num}",
                ))
    except Exception:
        raw_text = _extract_raw_strings(decision.file_path)
        if raw_text:
            chunks.append(RawChunk(
                text=raw_text[:4000],
                doc_id=doc_id,
                filename=filename,
                page_num=1,
                chunk_type="presentation",
                section="Presentation Content",
            ))
    return chunks


def extract_ocr(decision: RoutingDecision, doc_id: str, vision_fn: VisionFn) -> List[RawChunk]:
    """Dedicated OCR pipeline dispatcher. Handles multi-page scanned PDFs and images."""
    ext = Path(decision.file_path).suffix.lower()
    if ext == ".pdf":
        return extract_scanned_pdf(decision, doc_id, vision_fn)
    return extract_image(decision, doc_id, vision_fn)


def run_pipeline(decision: RoutingDecision, doc_id: str, vision_fn: Optional[VisionFn] = None) -> List[RawChunk]:
    """Single dispatch entry point the agent calls after routing."""
    if decision.pipeline == PipelineType.TEXT_PDF:
        return extract_text_pdf(decision, doc_id)
    if decision.pipeline == PipelineType.TABLE:
        return extract_table_pdf(decision, doc_id)
    if decision.pipeline == PipelineType.CSV:
        return extract_csv(decision, doc_id)
    if decision.pipeline == PipelineType.EXCEL:
        return extract_excel(decision, doc_id)
    if decision.pipeline == PipelineType.DOCX:
        return extract_docx(decision, doc_id)
    if decision.pipeline == PipelineType.PRESENTATION:
        return extract_presentation(decision, doc_id)
    if decision.pipeline == PipelineType.TEXT_DOC:
        return extract_text_doc(decision, doc_id)
    if decision.pipeline == PipelineType.SCANNED_PDF:
        if vision_fn is None:
            raise ValueError("Scanned PDF pipeline requires a vision_fn (Gemini vision call)")
        return extract_scanned_pdf(decision, doc_id, vision_fn)
    if decision.pipeline == PipelineType.IMAGE:
        if vision_fn is None:
            raise ValueError("Image pipeline requires a vision_fn (Gemini vision call)")
        return extract_image(decision, doc_id, vision_fn)
    if decision.pipeline == PipelineType.OCR:
        if vision_fn is None:
            raise ValueError("OCR pipeline requires a vision_fn (Gemini vision call)")
        return extract_ocr(decision, doc_id, vision_fn)
    raise ValueError(f"No pipeline registered for {decision.pipeline}")
