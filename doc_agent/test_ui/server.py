"""
Temporary test server for the Document Intelligence Agent chat interface.
This entire test_ui/ folder can be deleted at any time without impacting the agent.
"""

import os
import shutil
import socket
import sys

# Prevent macOS IPv6 routing failure (Errno 65: No route to host)
_orig_getaddrinfo = socket.getaddrinfo
def _ipv4_preferred_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    try:
        return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
    except Exception:
        return _orig_getaddrinfo(host, port, family, type, proto, flags)
socket.getaddrinfo = _ipv4_preferred_getaddrinfo

from typing import List, Optional
from pydantic import BaseModel

# Add project root to sys.path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from dotenv import load_dotenv
load_dotenv(os.path.join(BASE_DIR, ".env"))

import uvicorn
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from agent.gemini_client import get_llm_client, GeminiClient, MockGeminiClient
from agent.rag_agent import DocumentIntelligenceAgent

app = FastAPI(title="DocAgent Test UI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# State
_use_mock: bool = False  # default to real if key present, else mock
if not os.environ.get("GEMINI_API_KEY"):
    _use_mock = True

_agent: Optional[DocumentIntelligenceAgent] = None
_ingested_files: List[dict] = []


def create_agent(use_mock: bool) -> DocumentIntelligenceAgent:
    if use_mock or not os.environ.get("GEMINI_API_KEY"):
        llm = MockGeminiClient()
    else:
        llm = GeminiClient()
    return DocumentIntelligenceAgent(llm_client=llm)


def get_agent() -> DocumentIntelligenceAgent:
    global _agent
    if _agent is None:
        _agent = create_agent(_use_mock)
    return _agent


class QueryRequest(BaseModel):
    question: str
    session_id: str = "web_session"


class ToggleModeRequest(BaseModel):
    use_mock: bool


@app.get("/")
def serve_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/status")
def get_status():
    agent = get_agent()
    is_real = isinstance(agent.llm, GeminiClient)
    return {
        "engine": "Real Gemini" if is_real else "Mock (Offline / Grounded)",
        "is_real_gemini": is_real,
        "use_mock": _use_mock,
        "key_configured": bool(os.environ.get("GEMINI_API_KEY")),
        "model": getattr(agent.llm, "text_model_name", "Mock-Keyword-Engine"),
        "ingested_count": len(_ingested_files),
        "files": _ingested_files,
    }


@app.post("/api/toggle-mode")
def toggle_mode(req: ToggleModeRequest):
    global _use_mock, _agent, _ingested_files
    _use_mock = req.use_mock
    _agent = create_agent(_use_mock)
    _ingested_files = []
    return {
        "use_mock": _use_mock,
        "engine": "Mock (Offline / Grounded)" if _use_mock else "Real Gemini",
        "message": f"Switched engine to {'Mock (Offline)' if _use_mock else 'Real Gemini'}. Session re-initialized.",
    }


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
        err_msg = str(e)
        if "route to host" in err_msg.lower() or "connection" in err_msg.lower():
            err_msg += " (Transient network drop. Please retry, or click 'Switch to Mock (Offline)' in the sidebar to test completely offline)."
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {err_msg}")

    info = {
        "filename": filename,
        "path": dest_path,
        "status": result.get("status"),
        "pipeline": result.get("pipeline", "unknown"),
        "chunk_count": result.get("chunk_count", 0),
        "reason": result.get("reason", ""),
    }
    
    _ingested_files[:] = [f for f in _ingested_files if f["filename"] != filename]
    _ingested_files.append(info)

    return info


@app.post("/api/load-samples")
def load_sample_docs():
    from tests.generate_test_docs import generate_all
    docs_map = generate_all()
    agent = get_agent()
    results = []

    for name, path in docs_map.items():
        fname = os.path.basename(path)
        try:
            res = agent.ingest(path)
            info = {
                "filename": fname,
                "path": path,
                "status": res.get("status"),
                "pipeline": res.get("pipeline", "unknown"),
                "chunk_count": res.get("chunk_count", 0),
                "sample_key": name,
            }
            _ingested_files[:] = [f for f in _ingested_files if f["filename"] != fname]
            _ingested_files.append(info)
            results.append(info)
        except Exception as e:
            results.append({
                "filename": fname,
                "status": "error",
                "error": str(e),
                "pipeline": "unknown",
            })

    return {"loaded": len(results), "documents": results}


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


class OCRQueryRequest(BaseModel):
    question: str


@app.post("/api/ocr/query")
def ocr_query(req: OCRQueryRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")
    agent = get_agent()
    res = agent.ocr_agent.query(req.question)
    return {
        "status": res.status,
        "answer": res.answer,
        "evidence": res.evidence,
        "citations": res.citations,
        "extracted_data": res.extracted_data,
    }


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
        # Gracefully handle network timeouts or API errors
        err_msg = str(e)
        if "timeout" in err_msg.lower() or "connection" in err_msg.lower() or "network" in err_msg.lower():
            err_msg += " (Note: Gemini API requires outbound internet access. You can switch to Mock mode via the top toggle for offline testing)."
        raise HTTPException(status_code=500, detail=err_msg)


class ConflictResolveRequest(BaseModel):
    question: str
    session_id: str = "web_session"
    answer_context: Optional[str] = None
    api_key: Optional[str] = None


@app.post("/api/resolve-conflict")
def resolve_conflict(req: ConflictResolveRequest):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    agent = get_agent()
    try:
        result = agent.resolve_conflict_with_llm(
            question=req.question,
            answer_context=req.answer_context,
            api_key=req.api_key,
        )
        return result
    except Exception as e:
        err_msg = str(e)
        if "timeout" in err_msg.lower() or "connection" in err_msg.lower():
            err_msg += " (Network drop contacting dedicated Gemini endpoint. Please retry.)"
        raise HTTPException(status_code=500, detail=err_msg)


@app.post("/api/reset")
def reset_session():
    global _agent, _ingested_files
    _agent = create_agent(_use_mock)
    _ingested_files = []
    for f in os.listdir(UPLOAD_DIR):
        p = os.path.join(UPLOAD_DIR, f)
        if os.path.isfile(p):
            os.remove(p)
    return {"status": "ok", "message": "Agent and uploaded documents reset"}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

if __name__ == "__main__":
    uvicorn.run("test_ui.server:app", host="127.0.0.1", port=8000, reload=True)
