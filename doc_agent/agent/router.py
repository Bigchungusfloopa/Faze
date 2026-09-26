"""
Document Router
---------------
Decides which extraction pipeline a given uploaded file should go through.

Routing is NOT based on file extension alone -- for PDFs it probes actual
page content (extractable text length, presence of table structures) so a
scanned PDF and a text PDF (both .pdf) are correctly routed to different
pipelines. This mirrors the "Intelligent Document Processing" requirement.

Pipeline types:
    TEXT_PDF     -> PDF with a normal extractable text layer
    SCANNED_PDF  -> PDF with little/no extractable text (image-only pages)
    TABLE        -> PDF/CSV/XLSX where tabular structure dominates
    IMAGE        -> standalone image file (png/jpg/etc.)
    UNSUPPORTED  -> anything we explicitly refuse to process
"""

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional

import fitz  # PyMuPDF
import pdfplumber


class PipelineType(str, Enum):
    TEXT_PDF = "text_pdf"
    SCANNED_PDF = "scanned_pdf"
    TABLE = "table"
    CSV = "csv"
    EXCEL = "excel"
    DOCX = "docx"
    PRESENTATION = "presentation"
    TEXT_DOC = "text_doc"
    IMAGE = "image"
    OCR = "ocr"
    UNSUPPORTED = "unsupported"


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif", ".ico", ".svg"}
OCR_EXTS = {".tiff", ".tif", ".bmp", ".ocr"}
CSV_EXTS = {".csv", ".tsv"}
EXCEL_EXTS = {".xlsx", ".xls", ".xlsm", ".xlsb"}
DOCX_EXTS = {".docx", ".doc", ".docs"}
PPT_EXTS = {".pptx", ".ppt"}
TEXT_EXTS = {".txt", ".md", ".markdown", ".json", ".xml", ".html", ".log", ".yaml", ".yml", ".rst", ".rtf"}

# Below this many extractable characters per page (on average), we treat
# a PDF page as "image-only" and route it to the scanned/OCR pipeline.
MIN_CHARS_PER_PAGE = 40

# If a page's plumber-detected tables cover this fraction of pages, we
# tag the doc as table-dominant (still extracts prose too, but tables
# are pulled out as structured chunks).
TABLE_PAGE_RATIO_THRESHOLD = 0.5


@dataclass
class RoutingDecision:
    pipeline: PipelineType
    file_path: str
    reason: str
    page_count: Optional[int] = None
    has_tables: bool = False
    per_page_char_counts: list = field(default_factory=list)


class DocumentRouter:
    """Stateless classifier. Call `route(path)` for each uploaded file."""

    def route(self, file_path: str, force_ocr: bool = False) -> RoutingDecision:
        path = Path(file_path)
        ext = path.suffix.lower()

        if not path.exists():
            return RoutingDecision(
                pipeline=PipelineType.UNSUPPORTED,
                file_path=file_path,
                reason=f"File not found: {file_path}",
            )

        if force_ocr or ext in OCR_EXTS:
            return RoutingDecision(
                pipeline=PipelineType.OCR,
                file_path=file_path,
                reason="Routed to dedicated Optical Character Recognition (OCR) pipeline",
            )

        if ext in CSV_EXTS:
            return RoutingDecision(
                pipeline=PipelineType.CSV,
                file_path=file_path,
                reason=f"Extension {ext} routed to dedicated CSV tabular pipeline",
            )

        if ext in EXCEL_EXTS:
            return RoutingDecision(
                pipeline=PipelineType.EXCEL,
                file_path=file_path,
                reason=f"Extension {ext} routed to dedicated Excel multi-sheet pipeline",
            )

        if ext in DOCX_EXTS:
            return RoutingDecision(
                pipeline=PipelineType.DOCX,
                file_path=file_path,
                reason=f"Extension {ext} routed to dedicated Word DOCX document pipeline",
            )

        if ext in PPT_EXTS:
            return RoutingDecision(
                pipeline=PipelineType.PRESENTATION,
                file_path=file_path,
                reason=f"Extension {ext} routed to dedicated PowerPoint presentation pipeline",
            )

        if ext in TEXT_EXTS:
            return RoutingDecision(
                pipeline=PipelineType.TEXT_DOC,
                file_path=file_path,
                reason=f"Extension {ext} routed to dedicated Text/Markdown document pipeline",
            )

        if ext in IMAGE_EXTS:
            return RoutingDecision(
                pipeline=PipelineType.IMAGE,
                file_path=file_path,
                reason=f"Extension {ext} routed to dedicated Image & Vision OCR pipeline",
            )

        if ext == ".pdf":
            return self._route_pdf(str(path))

        return RoutingDecision(
            pipeline=PipelineType.UNSUPPORTED,
            file_path=file_path,
            reason=f"Extension {ext} is not supported by any pipeline",
        )

    def _route_pdf(self, file_path: str) -> RoutingDecision:
        doc = fitz.open(file_path)
        page_count = doc.page_count
        char_counts = []
        for page in doc:
            text = str(page.get_text("text"))
            char_counts.append(len(text.strip()))
        doc.close()

        avg_chars = sum(char_counts) / max(len(char_counts), 1)

        has_tables = self._detect_tables(file_path)

        if avg_chars < MIN_CHARS_PER_PAGE:
            return RoutingDecision(
                pipeline=PipelineType.SCANNED_PDF,
                file_path=file_path,
                reason=(
                    f"Average extractable text/page = {avg_chars:.1f} chars "
                    f"(< {MIN_CHARS_PER_PAGE}) -> treated as scanned/image-only"
                ),
                page_count=page_count,
                has_tables=has_tables,
                per_page_char_counts=char_counts,
            )

        if has_tables:
            return RoutingDecision(
                pipeline=PipelineType.TABLE,
                file_path=file_path,
                reason="Text-extractable PDF with significant detected table structure",
                page_count=page_count,
                has_tables=True,
                per_page_char_counts=char_counts,
            )

        return RoutingDecision(
            pipeline=PipelineType.TEXT_PDF,
            file_path=file_path,
            reason=(
                f"Average extractable text/page = {avg_chars:.1f} chars "
                f"(>= {MIN_CHARS_PER_PAGE}) -> normal text pipeline"
            ),
            page_count=page_count,
            has_tables=has_tables,
            per_page_char_counts=char_counts,
        )

    def _detect_tables(self, file_path: str) -> bool:
        try:
            with pdfplumber.open(file_path) as pdf:
                if not pdf.pages:
                    return False
                pages_with_tables = 0
                for page in pdf.pages:
                    tables = page.find_tables()
                    if tables:
                        pages_with_tables += 1
                return (pages_with_tables / len(pdf.pages)) >= TABLE_PAGE_RATIO_THRESHOLD
        except Exception:
            return False
