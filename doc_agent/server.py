"""
DocAgent Backend Server
-----------------------
FastAPI REST API connecting the Document Intelligence Agent with the Frontend.

Endpoints:
- POST /api/upload           -> Ingest documents across multi-pipelines
- POST /api/query            -> Multi-source grounded question answering
- POST /api/resolve-conflict -> LLM search conflict resolution
- GET  /api/status           -> Health & active engine metadata
- GET  /api/documents        -> List currently ingested documents
- GET  /api/schema           -> Active XLSX workbook dynamic schema
- GET  /api/ocr              -> Active OCR metadata & extracted fields
- POST /api/reset            -> Reset conversation session & documents
"""

import os
import sys
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from dotenv import load_dotenv
    load_dotenv()
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from agent.gemini_client import GeminiClient, MockGeminiClient, get_llm_client
from agent.rag_agent import DocumentIntelligenceAgent

app = FastAPI(title="DocAgent Intelligence API", version="1.0.0")

# CORS middleware for local Vite frontend dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = os.path.join(os.path.dirname(__file__), "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# Shared agent singleton
_agent: Optional[DocumentIntelligenceAgent] = None
_ingested_files: List[Dict[str, Any]] = []


def get_agent() -> DocumentIntelligenceAgent:
    global _agent
    if _agent is None:
        llm = get_llm_client()
        _agent = DocumentIntelligenceAgent(llm_client=llm)
    return _agent


class QueryRequest(BaseModel):
    question: str
    session_id: str = "web_session"


class ConflictResolveRequest(BaseModel):
    question: str
    session_id: str = "web_session"
    answer_context: Optional[str] = None


@app.get("/api/status")
def get_status():
    agent = get_agent()
    is_real = isinstance(agent.llm, GeminiClient)
    return {
        "status": "online",
        "engine": "Real Gemini" if is_real else "Mock (Offline / Grounded)",
        "is_real_gemini": is_real,
        "key_configured": bool(os.environ.get("GEMINI_API_KEY")),
        "model": getattr(agent.llm, "text_model_name", "Gemini-2.5-Flash"),
        "ingested_count": len(_ingested_files),
        "files": _ingested_files,
    }


@app.get("/api/documents")
def get_documents():
    return {"documents": _ingested_files, "count": len(_ingested_files)}


@app.delete("/api/documents/{filename}")
def delete_document(filename: str):
    global _ingested_files
    agent = get_agent()
    agent.delete_document(filename)
    _ingested_files = [f for f in _ingested_files if f["filename"] != filename]
    return {"message": f"Document {filename} removed", "status": "ok"}


@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    agent = get_agent()
    filename = os.path.basename(file.filename or "uploaded_doc")
    dest_path = os.path.join(UPLOAD_DIR, filename)

    with open(dest_path, "wb") as f:
        content = await file.read()
        f.write(content)

    try:
        result = agent.ingest(dest_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")

    info = {
        "filename": filename,
        "path": dest_path,
        "status": result.get("status"),
        "pipeline": result.get("pipeline", "unknown"),
        "chunk_count": result.get("chunk_count", 0),
        "reason": result.get("reason", ""),
        "xlsx_metadata": result.get("xlsx_metadata"),
        "ocr_metadata": result.get("ocr_metadata"),
    }

    if result.get("status") == "ok":
        _ingested_files[:] = [f for f in _ingested_files if f["filename"] != filename]
        _ingested_files.append(info)
    return info


@app.post("/api/query")
def ask_question(req: QueryRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    agent = get_agent()
    try:
        response = agent.query(req.question, session_id=req.session_id)
        return {
            "status": getattr(response, "status", "verified"),
            "answer": response.answer,
            "evidence": getattr(response, "evidence", []),
            "citations": response.citations,
            "grounded": response.grounded,
            "insufficient_evidence": response.insufficient_evidence,
            "conflicting": response.conflicting,
            "clarification_options": getattr(response, "clarification_options", None),
            "retrieved_chunk_count": len(response.retrieved_chunks),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/resolve-conflict")
def resolve_conflict(req: ConflictResolveRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    agent = get_agent()
    try:
        result = agent.resolve_conflict(
            question=req.question,
            session_id=req.session_id,
            answer_context=req.answer_context,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/schema")
def get_active_schema():
    agent = get_agent()
    if agent.xlsx_engine.current_workbook is not None:
        return agent.xlsx_engine.current_workbook.to_dict()
    return {"message": "No active workbook loaded", "sheets": {}}


@app.get("/api/ocr")
def get_active_ocr():
    agent = get_agent()
    if agent.ocr_agent.current_document is not None:
        return agent.ocr_agent.current_document.to_dict()
    return {"message": "No active OCR document loaded", "pages": []}


@app.post("/api/reset")
def reset_session():
    global _agent, _ingested_files
    llm = get_llm_client()
    _agent = DocumentIntelligenceAgent(llm_client=llm)
    _ingested_files = []
    return {"message": "Session reset successfully", "status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=True)
