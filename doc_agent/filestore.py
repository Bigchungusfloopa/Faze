"""
File storage module for DocAgent.
Enforces non-negotiable security rules:
- Max upload size <= 25MB
- Server-side extension and magic byte validation
- Safe path construction with per-user UUID directories (no path traversal)
- Default-private visibility
- Soft deletion preserving audit trails
"""

import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional
from uuid import uuid4

from db import get_db, log_audit

MAX_UPLOAD_BYTES: int = 25 * 1024 * 1024  # 25 MB

UPLOAD_BASE_DIR: str = os.environ.get(
    "DOC_AGENT_UPLOAD_DIR",
    os.path.join(os.path.dirname(__file__), "uploads"),
)

# Magic bytes mappings
_MAGIC_BYTES: Dict[str, bytes] = {
    ".pdf": b"%PDF",
    ".png": b"\x89PNG\r\n\x1a\n",
    ".jpg": b"\xff\xd8\xff",
    ".jpeg": b"\xff\xd8\xff",
    ".bmp": b"BM",
    ".gif": b"GIF8",
}


def sniff_and_validate_file_type(uploaded_bytes: bytes, original_filename: str) -> str:
    """
    Sniff actual file type server-side and reject mismatches with claimed extension.
    Raises ValueError on mismatch or invalid content.
    Returns cleaned lowercase extension.
    """
    ext = Path(original_filename).suffix.lower()
    if not ext:
        raise ValueError("File must have an explicit extension")

    # TODO: Add virus/malware scanning hook in future iteration

    # PDF validation
    if ext == ".pdf":
        if not uploaded_bytes.lstrip().startswith(b"%PDF"):
            raise ValueError("File content does not match claimed .pdf extension (invalid magic bytes)")
        return ext

    # PNG validation
    if ext == ".png":
        if not uploaded_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("File content does not match claimed .png extension (invalid magic bytes)")
        return ext

    # JPEG validation
    if ext in (".jpg", ".jpeg"):
        if not uploaded_bytes.startswith(b"\xff\xd8\xff"):
            raise ValueError("File content does not match claimed JPEG extension (invalid magic bytes)")
        return ext

    # GIF validation
    if ext == ".gif":
        if not (uploaded_bytes.startswith(b"GIF87a") or uploaded_bytes.startswith(b"GIF89a")):
            raise ValueError("File content does not match claimed .gif extension (invalid magic bytes)")
        return ext

    # BMP validation
    if ext == ".bmp":
        if not uploaded_bytes.startswith(b"BM"):
            raise ValueError("File content does not match claimed .bmp extension (invalid magic bytes)")
        return ext

    # TIFF validation
    if ext in (".tiff", ".tif"):
        if not (uploaded_bytes.startswith(b"II*\x00") or uploaded_bytes.startswith(b"MM\x00*")):
            raise ValueError("File content does not match claimed .tiff extension (invalid magic bytes)")
        return ext

    # WEBP validation
    if ext == ".webp":
        if len(uploaded_bytes) < 12 or uploaded_bytes[:4] != b"RIFF" or uploaded_bytes[8:12] != b"WEBP":
            raise ValueError("File content does not match claimed .webp extension (invalid magic bytes)")
        return ext

    # Modern OpenXML Office formats (ZIP-based: .xlsx, .xlsm, .docx, .pptx)
    if ext in (".xlsx", ".xlsm", ".xlsb", ".docx", ".pptx"):
        if not (uploaded_bytes.startswith(b"PK\x03\x04") or uploaded_bytes.startswith(b"PK\x05\x06") or uploaded_bytes.startswith(b"PK\x07\x08")):
            raise ValueError(f"File content does not match claimed {ext} extension (not a valid OpenXML archive)")
        return ext

    # Legacy Office formats (OLE2 Compound Document Header or ZIP)
    if ext in (".xls", ".doc", ".ppt"):
        is_ole = uploaded_bytes.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
        is_zip = uploaded_bytes.startswith(b"PK")
        if not (is_ole or is_zip):
            raise ValueError(f"File content does not match claimed {ext} extension (invalid Office header)")
        return ext

    # Text-based formats (.csv, .tsv, .txt, .md, .json)
    if ext in (".csv", ".tsv", ".txt", ".md", ".json"):
        # Check for excessive binary null bytes
        if b"\x00" in uploaded_bytes[:2048]:
            raise ValueError(f"File content does not match claimed text format {ext} (contains binary null bytes)")
        try:
            uploaded_bytes.decode("utf-8")
        except UnicodeDecodeError:
            try:
                uploaded_bytes.decode("latin-1")
            except Exception:
                raise ValueError(f"File content does not match claimed {ext} text format (encoding failure)")
        return ext

    # Other extensions: check that content is non-empty
    return ext


def save_upload(
    owner_id: str,
    uploaded_bytes: bytes,
    original_filename: str,
    db: Optional[sqlite3.Connection] = None,
    upload_dir: Optional[str] = None,
) -> dict:
    """
    - Validate size <= MAX_UPLOAD_BYTES, reject with a clear error otherwise.
    - Sniff actual file type server-side and reject if it doesn't match the claimed extension.
    - Generate file_id = uuid4().
    - Store at: uploads/{owner_id}/{file_id}{original_extension}
      (directory created if missing; NEVER use original_filename in the path)
    - Insert a row into `files` table: visibility='private', status='active'.
    - Write an audit_log row: action='upload'.
    - Return {file_id, storage_path, filename, status}.
    """
    if not owner_id or not str(owner_id).strip():
        raise ValueError("owner_id must be provided")

    # 1. Size validation
    if len(uploaded_bytes) > MAX_UPLOAD_BYTES:
        raise ValueError(
            f"File size ({len(uploaded_bytes)} bytes) exceeds maximum allowed size of {MAX_UPLOAD_BYTES} bytes (25 MB)"
        )
    if len(uploaded_bytes) == 0:
        raise ValueError("Uploaded file is empty (0 bytes)")

    # 2. Type validation / sniffing
    safe_ext = sniff_and_validate_file_type(uploaded_bytes, original_filename)

    # 3. Generate file_id
    file_id = str(uuid4())

    # 4. Safe filesystem path construction (No path traversal!)
    # Sanitize owner_id to strictly alphanumeric, dash, and underscore
    safe_owner_id = re.sub(r"[^a-zA-Z0-9_\-]", "", str(owner_id).strip()) or "anon_user"
    base_dir = Path(upload_dir or UPLOAD_BASE_DIR).resolve()
    user_dir = (base_dir / safe_owner_id).resolve()
    
    # Path traversal check
    if not str(user_dir).startswith(str(base_dir)):
        raise ValueError("Invalid owner_id path traversal detected")

    user_dir.mkdir(parents=True, exist_ok=True)
    target_storage_path = (user_dir / f"{file_id}{safe_ext}").resolve()

    if not str(target_storage_path).startswith(str(base_dir)):
        raise ValueError("Invalid storage path traversal detected")

    # Write file safely
    with open(target_storage_path, "wb") as f:
        f.write(uploaded_bytes)

    # 5. Insert into files table
    now_iso = datetime.now(timezone.utc).isoformat()
    conn = db or get_db()
    # Strip any directory path from display filename for hygiene
    display_filename = os.path.basename(original_filename)

    with conn:
        conn.execute(
            """
            INSERT INTO files (
                id, owner_id, filename, storage_path, pipeline,
                visibility, status, chunk_count, uploaded_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, 'private', 'active', 0, ?, NULL)
            """,
            (
                file_id,
                owner_id,
                display_filename,
                str(target_storage_path),
                safe_ext.lstrip("."),
                now_iso,
            ),
        )

    # 6. Audit log row
    log_audit(
        actor_id=owner_id,
        action="upload",
        file_id=file_id,
        detail=f"Uploaded {display_filename} ({len(uploaded_bytes)} bytes)",
        db=conn,
    )

    return {
        "file_id": file_id,
        "storage_path": str(target_storage_path),
        "filename": display_filename,
        "status": "active",
        "visibility": "private",
    }


def soft_delete(
    file_id: str,
    requester_id: str,
    db: Optional[sqlite3.Connection] = None,
    vector_store: Optional[Any] = None,
) -> dict:
    """
    - Only owner_id may delete (raise PermissionError / 403 otherwise).
    - Set status='deleted', deleted_at=now. Do NOT physically remove the
      file yet (soft delete only -- keeps this reversible and audit-safe).
    - Also remove/mark its chunks in the vector store as inaccessible.
    - Audit log: action='delete'.
    """
    conn = db or get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM files WHERE id = ?", (file_id,))
    row = cursor.fetchone()

    if not row:
        raise FileNotFoundError(f"File {file_id} not found")

    file_owner = row["owner_id"]
    if file_owner != requester_id:
        raise PermissionError(f"Permission denied: only file owner ({file_owner}) may delete this file")

    now_iso = datetime.now(timezone.utc).isoformat()
    with conn:
        conn.execute(
            "UPDATE files SET status = 'deleted', deleted_at = ? WHERE id = ?",
            (now_iso, file_id),
        )

    # Remove chunks from vector store hook if provided
    if vector_store is not None:
        if hasattr(vector_store, "delete_by_doc_id"):
            vector_store.delete_by_doc_id(file_id)
        elif hasattr(vector_store, "collection"):
            try:
                vector_store.collection.delete(where={"doc_id": file_id})
            except Exception:
                pass

    log_audit(
        actor_id=requester_id,
        action="delete",
        file_id=file_id,
        detail=f"Soft-deleted file {file_id} ({row['filename']})",
        db=conn,
    )

    return {"file_id": file_id, "status": "deleted"}
