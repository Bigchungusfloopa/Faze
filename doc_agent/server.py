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

from fastapi import FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import filestore
import access_control
from db import get_db, log_audit
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
    user_id: Optional[str] = None


class VisibilityRequest(BaseModel):
    visibility: str


class ShareRequest(BaseModel):
    target_user_id: str
    role: str = "viewer"


class ConflictResolveRequest(BaseModel):
    question: str
    session_id: str = "web_session"
    answer_context: Optional[str] = None
    user_id: Optional[str] = None


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
        result = agent.ingest(dest_path, original_filename=filename)
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
def ask_question(req: QueryRequest, x_user_id: Optional[str] = Header(None, alias="X-User-Id")):
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    actor = x_user_id or req.user_id or "default_user"
    agent = get_agent()
    try:
        response = agent.query(req.question, session_id=req.session_id, user_id=actor)
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


# ---------------------------------------------------------------------------
# TASK 4: Minimal File Management & Community Access Control API Surface
# ---------------------------------------------------------------------------

@app.post("/files/upload")
async def files_upload(
    file: UploadFile = File(...),
    owner_id: Optional[str] = Form(None),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """
    POST /files/upload
    Multipart form: {owner_id, file}
    Resolves actor from authenticated header X-User-Id, falling back to form owner_id.
    Validates size (<=25MB), sniffs magic bytes, creates safe per-user path,
    defaults visibility to 'private', and records in audit log.
    """
    actor = x_user_id or owner_id or "default_user"
    content = await file.read()
    orig_name = os.path.basename(file.filename or "upload")

    try:
        saved = filestore.save_upload(
            owner_id=actor,
            uploaded_bytes=content,
            original_filename=orig_name,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    agent = get_agent()
    try:
        ingest_res = agent.ingest(
            file_path=saved["storage_path"],
            doc_id=saved["file_id"],
            owner_id=actor,
            original_filename=orig_name,
        )
        saved["chunk_count"] = ingest_res.get("chunk_count", 0)
        saved["pipeline"] = ingest_res.get("pipeline", "unknown")
    except Exception:
        pass

    return saved


@app.get("/files")
def list_files(
    owner_id: Optional[str] = Query(None),
    status: Optional[str] = Query("active"),
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """
    GET /files?owner_id=...&status=active
    Lists caller's own files with optional status filter.
    """
    actor = x_user_id or owner_id or "default_user"
    conn = get_db()
    cursor = conn.cursor()
    if status:
        cursor.execute(
            """
            SELECT id, owner_id, filename, pipeline, visibility, status, chunk_count, uploaded_at, deleted_at
            FROM files
            WHERE owner_id = ? AND status = ?
            ORDER BY uploaded_at DESC
            """,
            (actor, status),
        )
    else:
        cursor.execute(
            """
            SELECT id, owner_id, filename, pipeline, visibility, status, chunk_count, uploaded_at, deleted_at
            FROM files
            WHERE owner_id = ?
            ORDER BY uploaded_at DESC
            """,
            (actor,),
        )
    files = [dict(row) for row in cursor.fetchall()]
    return {"files": files, "count": len(files)}


@app.get("/files/community")
def list_community_files(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """
    GET /files/community (paginated)
    Lists all community-visible, active documents.
    """
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT id, owner_id, filename, pipeline, visibility, status, chunk_count, uploaded_at
        FROM files
        WHERE visibility = 'community' AND status = 'active'
        ORDER BY uploaded_at DESC
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
    )
    files = [dict(row) for row in cursor.fetchall()]
    return {"files": files, "count": len(files), "limit": limit, "offset": offset}


@app.delete("/files/{file_id}")
def delete_file(
    file_id: str,
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """
    DELETE /files/{file_id}
    Soft-deletes file (owner-only).
    Removes vector chunks from retrieval index and logs audit event.
    """
    actor = x_user_id or "default_user"
    agent = get_agent()
    try:
        res = filestore.soft_delete(
            file_id=file_id,
            requester_id=actor,
            vector_store=agent.store,
        )
        return res
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/files/{file_id}/visibility")
def update_visibility(
    file_id: str,
    req: VisibilityRequest,
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """
    PATCH /files/{file_id}/visibility
    Changes visibility between private, shared, and community (owner-only).
    """
    actor = x_user_id or "default_user"
    try:
        res = access_control.set_visibility(
            file_id=file_id,
            owner_id=actor,
            new_visibility=req.visibility,
            requester_id=actor,
        )
        return res
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/files/{file_id}/share")
def share_file(
    file_id: str,
    req: ShareRequest,
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """
    POST /files/{file_id}/share
    Shares file with target user (owner-only).
    """
    actor = x_user_id or "default_user"
    try:
        res = access_control.share_with_user(
            file_id=file_id,
            owner_id=actor,
            target_user_id=req.target_user_id,
            requester_id=actor,
            role=req.role,
        )
        return res
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/query")
def execute_query(
    req: QueryRequest,
    x_user_id: Optional[str] = Header(None, alias="X-User-Id"),
):
    """
    POST /query
    Retrieval endpoint enforced with access control filtering.
    """
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    actor = x_user_id or req.user_id or "default_user"
    agent = get_agent()
    try:
        response = agent.query(
            question=req.question,
            session_id=req.session_id,
            user_id=actor,
        )
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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=True)
