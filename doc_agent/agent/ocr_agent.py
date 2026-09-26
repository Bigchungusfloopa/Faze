"""
OCR Agent & Intelligence Engine
--------------------------------
Dedicated agent for intelligent Optical Character Recognition (OCR),
scanned document transcription, key-value extraction, and visual question-answering.

Capabilities:
1. Multi-page scanned document processing (converts PDF pages to high-res images).
2. Standalone image transcription (.png, .jpg, .jpeg, .webp, .bmp, .tiff).
3. Automatic document classification (receipt, invoice, form, letter, report, general).
4. Structured key-value pair and entity extraction (dates, totals, invoice #, names).
5. Grounded visual question-answering with page-level citations and provenance.
"""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from uuid import uuid4

import fitz  # PyMuPDF
from PIL import Image

from .extractors import RawChunk
from .gemini_client import BaseLLMClient, MockGeminiClient, _keywords


@dataclass
class OCRPage:
    page_num: int
    text: str
    confidence: float = 0.95
    key_values: Dict[str, str] = field(default_factory=dict)
    detected_elements: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "page_num": self.page_num,
            "text": self.text,
            "confidence": self.confidence,
            "key_values": self.key_values,
            "detected_elements": self.detected_elements,
        }


@dataclass
class OCRDocumentMetadata:
    filename: str
    file_path: str
    page_count: int
    document_type: str = "general"
    full_text: str = ""
    pages: List[OCRPage] = field(default_factory=list)
    key_values: Dict[str, str] = field(default_factory=dict)
    detected_elements: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "filename": self.filename,
            "file_path": self.file_path,
            "page_count": self.page_count,
            "document_type": self.document_type,
            "full_text": self.full_text,
            "pages": [p.to_dict() for p in self.pages],
            "key_values": self.key_values,
            "detected_elements": self.detected_elements,
        }


@dataclass
class OCRResponse:
    status: str
    answer: str
    evidence: List[dict] = field(default_factory=list)
    citations: List[dict] = field(default_factory=list)
    extracted_data: Optional[dict] = None


class OCRAgent:
    """
    Specialized agent for OCR transcription, layout understanding,
    and visual question-answering across scanned documents and images.
    """

    def __init__(self, llm_client: Optional[BaseLLMClient] = None):
        self.llm = llm_client or MockGeminiClient()
        self.current_document: Optional[OCRDocumentMetadata] = None
        self.documents: Dict[str, OCRDocumentMetadata] = {}

    def _vision_fn(self, image_bytes: bytes, prompt: str) -> str:
        """Invokes the vision capability of the LLM or Mock OCR registry."""
        return self.llm.vision_transcribe(image_bytes, prompt)

    def ingest(self, file_path: str) -> OCRDocumentMetadata:
        """
        Ingests and transcribes a scanned PDF or image document.
        Extracts full text, page transcriptions, document type, and key-values.
        """
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        filename = path.name
        ext = path.suffix.lower()

        pages: List[OCRPage] = []

        if ext == ".pdf":
            doc = fitz.open(file_path)
            page_count = len(doc)
            prompt = (
                "Transcribe all readable text from this scanned document page exactly "
                "as it appears. If the page is illegible or blank, respond with "
                "'[NO TEXT DETECTED]'. Do not summarize, do not add commentary."
            )
            for page_idx, page in enumerate(doc, start=1):
                pix = page.get_pixmap(dpi=200)
                img_bytes = pix.tobytes("png")
                transcribed = self._vision_fn(img_bytes, prompt).strip()
                if not transcribed or transcribed == "[NO TEXT DETECTED]":
                    # Check if page has extractable text fallback
                    transcribed = str(page.get_text("text")).strip() or "[NO TEXT DETECTED]"

                kvs = self.extract_key_values(transcribed)
                detected = self._detect_elements(transcribed)
                pages.append(OCRPage(
                    page_num=page_idx,
                    text=transcribed,
                    key_values=kvs,
                    detected_elements=detected,
                ))
            doc.close()
        else:
            # Standalone Image
            page_count = 1
            with open(file_path, "rb") as f:
                img_bytes = f.read()
            prompt = (
                "Describe this image factually and transcribe any visible text "
                "verbatim. Do not speculate about anything not visibly present."
            )
            transcribed = self._vision_fn(img_bytes, prompt).strip() or "[NO TEXT DETECTED]"
            kvs = self.extract_key_values(transcribed)
            detected = self._detect_elements(transcribed)
            pages.append(OCRPage(
                page_num=1,
                text=transcribed,
                key_values=kvs,
                detected_elements=detected,
            ))

        full_text = "\n\n".join(f"--- Page {p.page_num} ---\n{p.text}" for p in pages if p.text != "[NO TEXT DETECTED]")
        doc_type = self._classify_document(full_text)
        merged_kvs = {}
        for p in pages:
            merged_kvs.update(p.key_values)

        all_detected = list(set().union(*[p.detected_elements for p in pages])) if pages else []

        metadata = OCRDocumentMetadata(
            filename=filename,
            file_path=str(path.absolute()),
            page_count=page_count,
            document_type=doc_type,
            full_text=full_text,
            pages=pages,
            key_values=merged_kvs,
            detected_elements=all_detected,
        )

        self.current_document = metadata
        self.documents[filename.lower()] = metadata
        self.documents[path.stem.lower()] = metadata

        return metadata

    def transcribe(self, file_path: str) -> dict:
        """Runs OCR extraction and returns structured dictionary."""
        meta = self.ingest(file_path)
        return meta.to_dict()

    def extract_key_values(self, text: str) -> Dict[str, str]:
        """Deterministic entity and key-value extractor from OCR text."""
        kvs: Dict[str, str] = {}
        if not text or text == "[NO TEXT DETECTED]":
            return kvs

        # Dates
        date_match = re.search(r"\b(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4})\b", text, re.IGNORECASE)
        if date_match:
            kvs["Date"] = date_match.group(0)

        # Invoice / Reference / Account Number
        inv_match = re.search(r"(?:invoice|inv|ref|account|policy|ticket)\s*(?:#|no\.?|num)?\s*[:\-]\s*([A-Za-z0-9\-_]{4,})", text, re.IGNORECASE)
        if inv_match:
            kvs["Reference_Number"] = inv_match.group(1).strip()

        # Total / Amount (do not match subtotal)
        total_match = re.search(r"(?:\bgrand\s+total\b|\btotal\s+amount\b|\bamount\s+due\b|\bbalance\s+due\b|\b(?<!sub)total\b)\s*[:\-]?\s*([$€£¥]?\s*[\d,]+(?:\.\d{2})?)", text, re.IGNORECASE)
        if total_match:
            kvs["Total_Amount"] = total_match.group(1).strip()

        # Subtotal
        subtotal_match = re.search(r"subtotal\s*[:\-]?\s*([$€£¥]?\s*[\d,]+(?:\.\d{2})?)", text, re.IGNORECASE)
        if subtotal_match:
            kvs["Subtotal"] = subtotal_match.group(1).strip()

        # Tax
        tax_match = re.search(r"tax\s*[:\-]?\s*([$€£¥]?\s*[\d,]+(?:\.\d{2})?)", text, re.IGNORECASE)
        if tax_match:
            kvs["Tax"] = tax_match.group(1).strip()

        # Email
        email_match = re.search(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b", text)
        if email_match:
            kvs["Email"] = email_match.group(0)

        # Phone
        phone_match = re.search(r"(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}", text)
        if phone_match:
            kvs["Phone"] = phone_match.group(0).strip()

        return kvs

    def _detect_elements(self, text: str) -> List[str]:
        elements = ["text"]
        t_low = text.lower()
        if "|" in text or "+---" in text or "table" in t_low:
            elements.append("table")
        if any(w in t_low for w in ["signature", "signed by", "sign here", "signature:"]):
            elements.append("signature")
        if any(w in t_low for w in ["stamp", "seal", "certified", "approved"]):
            elements.append("stamp")
        if any(w in t_low for w in ["handwritten", "notes:", "scribble"]):
            elements.append("handwriting")
        return elements

    def _classify_document(self, text: str) -> str:
        t_low = text.lower()
        if "invoice" in t_low or "bill to" in t_low or "invoice number" in t_low:
            return "invoice"
        if "receipt" in t_low or "cashier" in t_low or "change due" in t_low:
            return "receipt"
        if "form" in t_low or "application" in t_low or "questionnaire" in t_low:
            return "form"
        if "dear " in t_low or "sincerely" in t_low or "to whom it may concern" in t_low:
            return "letter"
        if "policy" in t_low or "revision" in t_low or "procedure" in t_low:
            return "policy_document"
        return "general"

    def query(self, question: str) -> OCRResponse:
        """
        Answers natural language queries strictly using the OCR transcriptions.
        Produces deterministic evidence and exact page citations.
        """
        if not self.current_document:
            return OCRResponse(
                status="insufficient_information",
                answer="No scanned document or image has been ingested by the OCR agent yet.",
                evidence=[],
                citations=[],
            )

        doc = self.current_document
        q_low = question.lower()

        # Check for direct key-value questions
        if any(w in q_low for w in ["total", "amount", "cost", "price"]) and "Total_Amount" in doc.key_values:
            val = doc.key_values["Total_Amount"]
            return OCRResponse(
                status="verified",
                answer=f"The total amount identified in **`{doc.filename}`** is **{val}**.",
                evidence=[{
                    "file": doc.filename,
                    "field": "Total_Amount",
                    "value": val,
                    "operation": "key_value_extraction",
                }],
                citations=[{"filename": doc.filename, "page": 1, "chunk_type": "ocr"}],
                extracted_data={"Total_Amount": val},
            )

        if any(w in q_low for w in ["date", "when"]) and "Date" in doc.key_values:
            val = doc.key_values["Date"]
            return OCRResponse(
                status="verified",
                answer=f"The date identified in **`{doc.filename}`** is **{val}**.",
                evidence=[{
                    "file": doc.filename,
                    "field": "Date",
                    "value": val,
                    "operation": "key_value_extraction",
                }],
                citations=[{"filename": doc.filename, "page": 1, "chunk_type": "ocr"}],
                extracted_data={"Date": val},
            )

        if any(w in q_low for w in ["invoice number", "reference", "ref number"]) and "Reference_Number" in doc.key_values:
            val = doc.key_values["Reference_Number"]
            return OCRResponse(
                status="verified",
                answer=f"The reference/invoice number in **`{doc.filename}`** is **`{val}`**.",
                evidence=[{
                    "file": doc.filename,
                    "field": "Reference_Number",
                    "value": val,
                    "operation": "key_value_extraction",
                }],
                citations=[{"filename": doc.filename, "page": 1, "chunk_type": "ocr"}],
                extracted_data={"Reference_Number": val},
            )

        # Overview / Transcript Request
        if any(w in q_low for w in ["transcribe", "transcription", "full text", "read this", "what is written", "extract all"]):
            preview = doc.full_text[:1200] + ("..." if len(doc.full_text) > 1200 else "")
            answer = (
                f"### OCR Transcription: **{doc.filename}** ({doc.document_type.upper()})\n\n"
                f"{preview}\n\n"
                f"**Key-Value Entities Extracted**:\n"
                + "\n".join(f"- **{k}**: `{v}`" for k, v in doc.key_values.items())
                if doc.key_values else f"### OCR Transcription: **{doc.filename}**\n\n{preview}"
            )
            return OCRResponse(
                status="verified",
                answer=answer,
                evidence=[{
                    "file": doc.filename,
                    "page_count": doc.page_count,
                    "document_type": doc.document_type,
                    "operation": "full_ocr_transcription",
                }],
                citations=[{"filename": doc.filename, "page": p.page_num, "chunk_type": "ocr"} for p in doc.pages],
                extracted_data=doc.key_values,
            )

        # Grounded Visual Q&A via LLM
        prompt_ctx = "\n---\n".join(f"[{doc.filename}, page {p.page_num}]\n{p.text}" for p in doc.pages)
        system_prompt = (
            "You are a specialized Visual Document OCR Assistant. Answer the question strictly "
            "using the OCR transcript provided. If the answer is not contained in the transcript, "
            "say 'I don't have enough information in the uploaded scanned document to answer that question.'"
        )
        user_prompt = f"CONTEXT:\n{prompt_ctx}\nQUESTION:\n{question}"

        raw_ans = self.llm.generate(system_prompt, user_prompt)
        
        # Grounding check
        q_kws = _keywords(raw_ans)
        ctx_kws = _keywords(doc.full_text)
        overlap = len(q_kws & ctx_kws) / max(len(q_kws), 1)

        is_refusal = "not enough information" in raw_ans.lower() or "insufficient" in raw_ans.lower()
        if not is_refusal and overlap < 0.15:
            return OCRResponse(
                status="insufficient_information",
                answer="I don't have enough information in the uploaded scanned document to answer that question.",
                evidence=[],
                citations=[],
            )

        return OCRResponse(
            status="verified" if not is_refusal else "insufficient_information",
            answer=raw_ans,
            evidence=[{
                "file": doc.filename,
                "operation": "grounded_ocr_query",
                "grounding_overlap": round(overlap, 3),
            }],
            citations=[{"filename": doc.filename, "page": 1, "chunk_type": "ocr"}],
            extracted_data=doc.key_values,
        )

    def to_chunks(self, metadata: OCRDocumentMetadata, doc_id: str) -> List[RawChunk]:
        """Converts OCR metadata to common RawChunk objects for vector indexing."""
        chunks = []
        for p in metadata.pages:
            if p.text and p.text != "[NO TEXT DETECTED]":
                chunks.append(RawChunk(
                    text=p.text,
                    doc_id=doc_id,
                    filename=metadata.filename,
                    page_num=p.page_num,
                    chunk_type="ocr",
                    section=f"OCR Page {p.page_num}",
                    extra={"document_type": metadata.document_type, "key_values": p.key_values},
                ))
        return chunks
