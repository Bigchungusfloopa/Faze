"""
Database connection and schema definitions for DocAgent File Management & Access Control.
Uses SQLite for fast, zero-setup storage.
"""

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DEFAULT_DB_PATH = os.environ.get(
    "DOC_AGENT_DB_PATH",
    os.path.join(os.path.dirname(__file__), "files.db"),
)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS files (
    id              TEXT PRIMARY KEY,        -- uuid4
    owner_id        TEXT NOT NULL,
    filename        TEXT NOT NULL,           -- original name, display only, never used as a path
    storage_path    TEXT NOT NULL,           -- actual sanitized path on disk
    pipeline        TEXT,                    -- text_pdf | scanned_pdf | table | image
    visibility      TEXT NOT NULL DEFAULT 'private',  -- private | shared | community
    status          TEXT NOT NULL DEFAULT 'active',   -- active | deleted
    chunk_count     INTEGER DEFAULT 0,
    uploaded_at     TEXT NOT NULL,
    deleted_at      TEXT
);

CREATE TABLE IF NOT EXISTS file_shares (        -- explicit user-to-user shares (visibility='shared')
    file_id     TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'viewer',   -- viewer | editor
    shared_at   TEXT NOT NULL,
    PRIMARY KEY (file_id, user_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id    TEXT NOT NULL,
    action      TEXT NOT NULL,       -- upload | delete | share | unshare | visibility_change | query
    file_id     TEXT,
    detail      TEXT,
    at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
CREATE INDEX IF NOT EXISTS idx_files_status_visibility ON files(status, visibility);
CREATE INDEX IF NOT EXISTS idx_file_shares_user ON file_shares(user_id);
"""


def init_db(db_path: Optional[str] = None) -> sqlite3.Connection:
    """Initialize SQLite database with the required tables and return connection."""
    target_path = db_path or DEFAULT_DB_PATH
    if target_path != ":memory:":
        Path(target_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(target_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    with conn:
        conn.executescript(SCHEMA_SQL)
    return conn


def get_db(db_path: Optional[str] = None) -> sqlite3.Connection:
    """Return an active connection to the database (initializing schema if needed)."""
    conn = init_db(db_path)
    return conn


def log_audit(
    actor_id: str,
    action: str,
    file_id: Optional[str] = None,
    detail: Optional[str] = None,
    db: Optional[sqlite3.Connection] = None,
) -> int:
    """Insert an entry into the audit_log table."""
    conn = db or get_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT INTO audit_log (actor_id, action, file_id, detail, at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (actor_id, action, file_id, detail, now_iso),
    )
    conn.commit()
    return cursor.lastrowid or 0
