"""
Acceptance tests for File Management & Community Access Control Layer (Tasks 1, 2, 3).
"""

import os
import sqlite3
import tempfile
from pathlib import Path
import pytest

from db import init_db, get_db
from filestore import save_upload, soft_delete, MAX_UPLOAD_BYTES
from access_control import can_view, visible_file_ids_for, set_visibility, share_with_user
from agent.gemini_client import MockGeminiClient
from agent.rag_agent import DocumentIntelligenceAgent, INSUFFICIENT_EVIDENCE_MSG
from agent.vector_store import VectorStore


@pytest.fixture
def test_db():
    """Create an isolated in-memory or temp SQLite DB."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    conn = init_db(path)
    yield conn, path
    conn.close()
    if os.path.exists(path):
        os.remove(path)


@pytest.fixture
def test_upload_dir():
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


# ---------------------------------------------------------------------------
# TASK 1 ACCEPTANCE TESTS
# ---------------------------------------------------------------------------
def test_task1_no_collision_same_filename_different_users(test_db, test_upload_dir):
    """
    Acceptance check Task 1:
    Uploading the same original filename twice from two different users
    must not collide or overwrite (per-user, per-file_id directories).
    """
    conn, _ = test_db
    content_a = b"Secret financial strategy for User A."
    content_b = b"Personal medical notes for User B."

    res_a = save_upload(
        owner_id="user_alice",
        uploaded_bytes=content_a,
        original_filename="notes.txt",
        db=conn,
        upload_dir=test_upload_dir,
    )

    res_b = save_upload(
        owner_id="user_bob",
        uploaded_bytes=content_b,
        original_filename="notes.txt",
        db=conn,
        upload_dir=test_upload_dir,
    )

    assert res_a["file_id"] != res_b["file_id"]
    assert res_a["storage_path"] != res_b["storage_path"]
    assert os.path.exists(res_a["storage_path"])
    assert os.path.exists(res_b["storage_path"])

    with open(res_a["storage_path"], "rb") as f:
        assert f.read() == content_a
    with open(res_b["storage_path"], "rb") as f:
        assert f.read() == content_b

    # Verify audit log records
    cur = conn.cursor()
    cur.execute("SELECT action, actor_id, file_id FROM audit_log WHERE action='upload'")
    logs = cur.fetchall()
    assert len(logs) == 2


def test_task1_size_limits_and_magic_byte_sniffing(test_db, test_upload_dir):
    conn, _ = test_db

    # 1. Reject size > 25MB
    oversized = b"x" * (MAX_UPLOAD_BYTES + 10)
    with pytest.raises(ValueError, match="exceeds maximum allowed size"):
        save_upload("user_a", oversized, "big.txt", db=conn, upload_dir=test_upload_dir)

    # 2. Reject empty file
    with pytest.raises(ValueError, match="empty"):
        save_upload("user_a", b"", "empty.txt", db=conn, upload_dir=test_upload_dir)

    # 3. Reject claimed PDF with invalid magic bytes
    fake_pdf = b"Plain text claiming to be a PDF"
    with pytest.raises(ValueError, match="does not match claimed .pdf extension"):
        save_upload("user_a", fake_pdf, "malicious.pdf", db=conn, upload_dir=test_upload_dir)

    # 4. Accept valid PDF magic bytes
    valid_pdf = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"
    res_pdf = save_upload("user_a", valid_pdf, "valid.pdf", db=conn, upload_dir=test_upload_dir)
    assert res_pdf["status"] == "active"


def test_task1_soft_delete(test_db, test_upload_dir):
    conn, _ = test_db
    content = b"Content to be deleted"
    up = save_upload("user_a", content, "delete_me.txt", db=conn, upload_dir=test_upload_dir)
    file_id = up["file_id"]

    # Non-owner cannot delete
    with pytest.raises(PermissionError, match="Permission denied"):
        soft_delete(file_id, requester_id="user_intruder", db=conn)

    # Owner deletes
    del_res = soft_delete(file_id, requester_id="user_a", db=conn)
    assert del_res["status"] == "deleted"

    # Verify soft delete: physical file STILL exists on disk
    assert os.path.exists(up["storage_path"])

    # DB status is deleted
    cur = conn.cursor()
    cur.execute("SELECT status, deleted_at FROM files WHERE id = ?", (file_id,))
    row = cur.fetchone()
    assert row["status"] == "deleted"
    assert row["deleted_at"] is not None


# ---------------------------------------------------------------------------
# TASK 2 ACCEPTANCE TESTS
# ---------------------------------------------------------------------------
def test_task2_access_control_rules(test_db, test_upload_dir):
    conn, _ = test_db

    # User A uploads a private doc
    up = save_upload("user_a", b"Private data", "data.txt", db=conn, upload_dir=test_upload_dir)
    file_id = up["file_id"]

    # Initial state: only user_a can view
    visible_a = visible_file_ids_for("user_a", db=conn)
    visible_b = visible_file_ids_for("user_b", db=conn)
    assert file_id in visible_a
    assert file_id not in visible_b

    # Non-owner cannot change visibility
    with pytest.raises(PermissionError):
        set_visibility(file_id, owner_id="user_b", new_visibility="community", requester_id="user_b", db=conn)

    # Share with user_b explicitly (visibility remains private/shared)
    share_with_user(file_id, owner_id="user_a", target_user_id="user_b", requester_id="user_a", role="viewer", db=conn)
    visible_b_after_share = visible_file_ids_for("user_b", db=conn)
    visible_c_after_share = visible_file_ids_for("user_c", db=conn)
    assert file_id in visible_b_after_share
    assert file_id not in visible_c_after_share

    # Owner changes visibility to community
    set_visibility(file_id, owner_id="user_a", new_visibility="community", requester_id="user_a", db=conn)
    visible_c_after_community = visible_file_ids_for("user_c", db=conn)
    assert file_id in visible_c_after_community

    # Soft delete makes it invisible to everyone
    soft_delete(file_id, requester_id="user_a", db=conn)
    assert file_id not in visible_file_ids_for("user_a", db=conn)
    assert file_id not in visible_file_ids_for("user_b", db=conn)
    assert file_id not in visible_file_ids_for("user_c", db=conn)


# ---------------------------------------------------------------------------
# TASK 3 ACCEPTANCE TEST (MANDATORY SECURITY BOUNDARY TEST)
# ---------------------------------------------------------------------------
def test_task3_retrieval_access_boundary_acceptance_test(test_db, test_upload_dir):
    """
    CRITICAL ACCEPTANCE TEST (TASK 3 SPECIFICATION):
    1. User A uploads a private doc.
    2. User B queries with a question only answerable from that doc.
    3. Assert User B's response is insufficient_evidence=True and cites nothing.
    4. User A sets that file's visibility to community.
    5. Re-run User B's identical query.
    6. Assert it now succeeds with a correct, cited answer.
    """
    conn, _ = test_db

    # Initialize shared agent with Mock LLM
    agent = DocumentIntelligenceAgent(llm_client=MockGeminiClient())

    # User A creates and uploads a private document with secret facts
    unique_secret_fact = "The secret Falcon Project code name is Project-Aquila-9988."
    file_bytes = unique_secret_fact.encode("utf-8")
    upload_res = save_upload(
        owner_id="user_a",
        uploaded_bytes=file_bytes,
        original_filename="falcon_classified.txt",
        db=conn,
        upload_dir=test_upload_dir,
    )
    file_id = upload_res["file_id"]
    storage_path = upload_res["storage_path"]

    # Ingest file into agent for User A
    ingest_res = agent.ingest(
        file_path=storage_path,
        doc_id=file_id,
        owner_id="user_a",
        db=conn,
    )
    assert ingest_res["status"] == "ok"
    assert ingest_res["chunk_count"] >= 1

    # Verify vector store explicitly raises ValueError if allowed_file_ids is omitted (None)
    with pytest.raises(ValueError, match="allowed_file_ids must be explicitly provided"):
        dummy_emb = agent.llm.embed("What is the code name?")
        agent.store.query(dummy_emb, k=5, allowed_file_ids=None)

    # 1. User A queries the document -> succeeds
    query_text = "What is the secret Falcon Project code name?"
    resp_a = agent.query(
        question=query_text,
        session_id="session_a",
        user_id="user_a",
        db=conn,
    )
    assert resp_a.insufficient_evidence is False
    assert resp_a.grounded is True
    assert len(resp_a.citations) >= 1
    assert "falcon_classified.txt" in resp_a.citations[0]["filename"]

    # 2. User B queries with identical question -> MUST FAIL with insufficient_evidence
    resp_b = agent.query(
        question=query_text,
        session_id="session_b",
        user_id="user_b",
        db=conn,
    )
    assert resp_b.insufficient_evidence is True
    assert resp_b.citations == []
    assert INSUFFICIENT_EVIDENCE_MSG in resp_b.answer

    # 3. User A sets visibility of the file to 'community'
    set_visibility(
        file_id=file_id,
        owner_id="user_a",
        new_visibility="community",
        requester_id="user_a",
        db=conn,
    )

    # 4. User B re-runs identical query -> MUST NOW SUCCEED with citation!
    resp_b_second = agent.query(
        question=query_text,
        session_id="session_b_second",
        user_id="user_b",
        db=conn,
    )
    assert resp_b_second.insufficient_evidence is False
    assert resp_b_second.grounded is True
    assert len(resp_b_second.citations) >= 1
    assert "falcon_classified.txt" in resp_b_second.citations[0]["filename"]

    # 5. Check audit logs contain upload, query, and visibility change
    cur = conn.cursor()
    cur.execute("SELECT action, actor_id FROM audit_log ORDER BY id ASC")
    all_logs = cur.fetchall()
    actions = [row["action"] for row in all_logs]
    assert "upload" in actions
    assert "query" in actions
    assert "visibility_change" in actions
