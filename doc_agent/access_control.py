"""
Access control module for DocAgent.
Enforces multi-tenant isolation, community boundaries, and fine-grained sharing.
"""

import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union

from db import get_db, log_audit

VALID_VISIBILITY_LEVELS = ("private", "shared", "community")
VALID_ROLES = ("viewer", "editor")


def can_view(
    user_id: str,
    file_row: Union[Dict[str, Any], sqlite3.Row],
    shares: Optional[List[Union[Dict[str, Any], sqlite3.Row]]] = None,
) -> bool:
    """
    Evaluate viewing permission for a single file.
    True if:
      - file_row['owner_id'] == user_id, OR
      - file_row['visibility'] == 'community', OR
      - file_row['visibility'] == 'shared' AND user_id appears in shares
        for that file_id (or user_id is in shares).
    False if file_row['status'] == 'deleted', regardless of the above.
    """
    row_dict = dict(file_row)

    # Soft-deleted files are NEVER viewable
    if row_dict.get("status") == "deleted":
        return False

    # Owner always has view rights
    if row_dict.get("owner_id") == user_id:
        return True

    # Community visibility allows all authenticated users
    if row_dict.get("visibility") == "community":
        return True

    # Check explicit shares
    shares_list = shares or []
    file_id = row_dict.get("id")
    for share in shares_list:
        s_dict = dict(share)
        # Match file_id if present in share, and match target user
        if (s_dict.get("file_id") is None or s_dict.get("file_id") == file_id) and s_dict.get("user_id") == user_id:
            return True

    return False


def visible_file_ids_for(user_id: str, db: Optional[sqlite3.Connection] = None) -> List[str]:
    """
    Single query returning every file_id this user is allowed to see:
    UNION of (own files) + (community files) + (files explicitly shared
    with this user_id). Active files only.
    This is passed into the vector store retrieval filter.
    """
    conn = db or get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT id FROM files
        WHERE status = 'active' AND (
            owner_id = ?
            OR visibility = 'community'
            OR id IN (SELECT file_id FROM file_shares WHERE user_id = ?)
        )
        ORDER BY uploaded_at DESC
        """,
        (user_id, user_id),
    )
    rows = cursor.fetchall()
    return [str(row[0]) for row in rows]


def set_visibility(
    file_id: str,
    owner_id: str,
    new_visibility: str,
    requester_id: str,
    db: Optional[sqlite3.Connection] = None,
) -> Dict[str, Any]:
    """
    Only owner_id may change visibility. Validate new_visibility is one of
    private/shared/community. Audit log: action='visibility_change'.
    """
    if new_visibility not in VALID_VISIBILITY_LEVELS:
        raise ValueError(
            f"Invalid visibility '{new_visibility}'. Must be one of: {', '.join(VALID_VISIBILITY_LEVELS)}"
        )

    conn = db or get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM files WHERE id = ?", (file_id,))
    row = cursor.fetchone()

    if not row:
        raise FileNotFoundError(f"File {file_id} not found")

    file_owner = row["owner_id"]
    if file_owner != requester_id or file_owner != owner_id:
        raise PermissionError(f"Permission denied: only file owner ({file_owner}) may change visibility")

    old_vis = row["visibility"]
    with conn:
        conn.execute(
            "UPDATE files SET visibility = ? WHERE id = ?",
            (new_visibility, file_id),
        )

    log_audit(
        actor_id=requester_id,
        action="visibility_change",
        file_id=file_id,
        detail=f"Visibility changed from {old_vis} to {new_visibility}",
        db=conn,
    )

    return {
        "file_id": file_id,
        "visibility": new_visibility,
        "previous_visibility": old_vis,
    }


def share_with_user(
    file_id: str,
    owner_id: str,
    target_user_id: str,
    requester_id: str,
    role: str = "viewer",
    db: Optional[sqlite3.Connection] = None,
) -> Dict[str, Any]:
    """
    Only owner_id may share. Insert/replace row in file_shares.
    Does NOT change visibility to 'community' -- 'shared' is a separate
    state from 'community'; a file can be shared with specific users
    while still being visibility='private' at the workspace-wide level.
    Audit log: action='share'.
    """
    if role not in VALID_ROLES:
        raise ValueError(f"Invalid role '{role}'. Must be one of: {', '.join(VALID_ROLES)}")

    conn = db or get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM files WHERE id = ?", (file_id,))
    row = cursor.fetchone()

    if not row:
        raise FileNotFoundError(f"File {file_id} not found")

    file_owner = row["owner_id"]
    if file_owner != requester_id or file_owner != owner_id:
        raise PermissionError(f"Permission denied: only file owner ({file_owner}) may share this file")

    now_iso = datetime.now(timezone.utc).isoformat()
    with conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO file_shares (file_id, user_id, role, shared_at)
            VALUES (?, ?, ?, ?)
            """,
            (file_id, target_user_id, role, now_iso),
        )

    log_audit(
        actor_id=requester_id,
        action="share",
        file_id=file_id,
        detail=f"Shared file with user '{target_user_id}' as role '{role}'",
        db=conn,
    )

    return {
        "file_id": file_id,
        "target_user_id": target_user_id,
        "role": role,
        "shared_at": now_iso,
    }
