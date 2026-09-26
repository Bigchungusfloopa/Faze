import os
import sys
from pathlib import Path

import pytest

from agent.gemini_client import MockGeminiClient
from agent.ocr_agent import OCRAgent, OCRDocumentMetadata, OCRResponse
from agent.router import DocumentRouter, PipelineType
from tests.generate_test_docs import generate_all


@pytest.fixture(scope="module")
def docs():
    return generate_all()


@pytest.fixture()
def ocr_agent():
    return OCRAgent(llm_client=MockGeminiClient())


def test_ocr_pipeline_routing(tmp_path):
    router = DocumentRouter()
    # Explicit force_ocr routing
    dummy_pdf = tmp_path / "invoice.pdf"
    dummy_pdf.write_bytes(b"%PDF-1.4 dummy")
    decision = router.route(str(dummy_pdf), force_ocr=True)
    assert decision.pipeline == PipelineType.OCR

    # Specialized OCR extension .tiff / .bmp
    dummy_tiff = tmp_path / "scan.tiff"
    dummy_tiff.write_bytes(b"dummy tiff bytes")
    decision_tiff = router.route(str(dummy_tiff))
    assert decision_tiff.pipeline == PipelineType.OCR


def test_ocr_agent_ingest_scanned_pdf(ocr_agent, docs):
    meta = ocr_agent.ingest(docs["scanned"])
    assert isinstance(meta, OCRDocumentMetadata)
    assert meta.page_count >= 1
    assert len(meta.pages) >= 1
    assert "maintenance" in meta.full_text.lower() or "server" in meta.full_text.lower()
    assert ocr_agent.current_document is not None


def test_ocr_agent_ingest_image(ocr_agent, docs):
    meta = ocr_agent.ingest(docs["image"])
    assert isinstance(meta, OCRDocumentMetadata)
    assert meta.page_count == 1
    assert "northwind" in meta.full_text.lower() or "logistics" in meta.full_text.lower()


def test_ocr_agent_key_value_extraction(ocr_agent):
    sample_text = (
        "INVOICE\n"
        "Invoice #: INV-2026-8891\n"
        "Date: 2026-09-26\n"
        "Bill To: user@company.com\n"
        "Subtotal: $1,250.00\n"
        "Tax: $125.00\n"
        "Total Amount: $1,375.00\n"
        "Phone: (555) 123-4567\n"
        "Approved and Signed: John Doe\n"
    )
    kvs = ocr_agent.extract_key_values(sample_text)
    assert kvs.get("Reference_Number") == "INV-2026-8891"
    assert kvs.get("Date") == "2026-09-26"
    assert "$1,375.00" in kvs.get("Total_Amount", "")
    assert "$1,250.00" in kvs.get("Subtotal", "")
    assert "$125.00" in kvs.get("Tax", "")
    assert kvs.get("Email") == "user@company.com"


def test_ocr_agent_query_transcription(ocr_agent, docs):
    ocr_agent.ingest(docs["scanned"])
    resp = ocr_agent.query("Transcribe the document")
    assert resp.status == "verified"
    assert len(resp.citations) >= 1
    assert len(resp.evidence) >= 1


def test_ocr_agent_query_grounded_answer(ocr_agent, docs):
    ocr_agent.ingest(docs["scanned"])
    resp = ocr_agent.query("Why is the parking garage closed?")
    assert resp.status == "verified"
    assert "maintenance" in resp.answer.lower()


def test_ocr_agent_refuses_unseen_facts(ocr_agent, docs):
    ocr_agent.ingest(docs["scanned"])
    resp = ocr_agent.query("What was the stock price of Tesla?")
    assert resp.status == "insufficient_information"


def test_ocr_agent_to_chunks(ocr_agent, docs):
    meta = ocr_agent.ingest(docs["scanned"])
    chunks = ocr_agent.to_chunks(meta, doc_id="doc-123")
    assert len(chunks) >= 1
    assert chunks[0].chunk_type == "ocr"
    assert chunks[0].doc_id == "doc-123"
