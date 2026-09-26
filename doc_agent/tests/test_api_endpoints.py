"""
Tests for Task 4: Minimal File Management & Access Control API Surface.
"""

import io
from fastapi.testclient import TestClient
import pytest

from server import app


@pytest.fixture
def client():
    return TestClient(app)


def test_task4_api_full_workflow(client):
    # Reset
    res_reset = client.post("/api/reset")
    assert res_reset.status_code == 200

    # 1. User A uploads a document via POST /files/upload with X-User-Id
    doc_content = b"Super confidential strategic roadmap for Project Titan."
    upload_res = client.post(
        "/files/upload",
        files={"file": ("titan_roadmap.txt", io.BytesIO(doc_content), "text/plain")},
        headers={"X-User-Id": "user_alice"},
    )
    assert upload_res.status_code == 200
    file_meta = upload_res.json()
    file_id = file_meta["file_id"]
    assert file_meta["status"] == "active"
    assert file_meta["visibility"] == "private"
    assert file_meta["filename"] == "titan_roadmap.txt"

    # 2. List own files for user_alice
    list_alice = client.get("/files", headers={"X-User-Id": "user_alice"})
    assert list_alice.status_code == 200
    files_a = list_alice.json()["files"]
    assert any(f["id"] == file_id for f in files_a)

    # List own files for user_bob -> must be empty
    list_bob = client.get("/files", headers={"X-User-Id": "user_bob"})
    assert list_bob.status_code == 200
    files_b = list_bob.json()["files"]
    assert not any(f["id"] == file_id for f in files_b)

    # 3. Community files endpoint -> currently empty because file is private
    comm_res1 = client.get("/files/community")
    assert comm_res1.status_code == 200
    assert not any(f["id"] == file_id for f in comm_res1.json()["files"])

    # 4. User Bob queries POST /query for Project Titan -> insufficient evidence
    q_bob = client.post(
        "/query",
        json={"question": "What is the strategic roadmap for Project Titan?"},
        headers={"X-User-Id": "user_bob"},
    )
    assert q_bob.status_code == 200
    assert q_bob.json()["insufficient_evidence"] is True
    assert q_bob.json()["citations"] == []

    # 5. Non-owner (user_bob) attempts to change visibility -> 403 Forbidden
    patch_forbidden = client.patch(
        f"/files/{file_id}/visibility",
        json={"visibility": "community"},
        headers={"X-User-Id": "user_bob"},
    )
    assert patch_forbidden.status_code == 403

    # 6. User Alice shares with User Bob
    share_res = client.post(
        f"/files/{file_id}/share",
        json={"target_user_id": "user_bob", "role": "viewer"},
        headers={"X-User-Id": "user_alice"},
    )
    assert share_res.status_code == 200
    assert share_res.json()["target_user_id"] == "user_bob"

    # 7. User Bob now queries -> succeeds!
    q_bob_shared = client.post(
        "/query",
        json={"question": "What is the strategic roadmap for Project Titan?"},
        headers={"X-User-Id": "user_bob"},
    )
    assert q_bob_shared.status_code == 200
    assert q_bob_shared.json()["insufficient_evidence"] is False
    assert len(q_bob_shared.json()["citations"]) >= 1

    # 8. User Alice changes visibility to community
    patch_ok = client.patch(
        f"/files/{file_id}/visibility",
        json={"visibility": "community"},
        headers={"X-User-Id": "user_alice"},
    )
    assert patch_ok.status_code == 200
    assert patch_ok.json()["visibility"] == "community"

    # Community list now includes file
    comm_res2 = client.get("/files/community")
    assert any(f["id"] == file_id for f in comm_res2.json()["files"])

    # 9. Soft-delete file (user_alice)
    del_res = client.delete(f"/files/{file_id}", headers={"X-User-Id": "user_alice"})
    assert del_res.status_code == 200
    assert del_res.json()["status"] == "deleted"

    # Verify deleted file is no longer queryable or visible in active lists
    list_after = client.get("/files?status=active", headers={"X-User-Id": "user_alice"})
    assert not any(f["id"] == file_id for f in list_after.json()["files"])
