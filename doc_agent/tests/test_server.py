"""
Test the FastAPI Backend Server endpoints used by the React Frontend.
"""

import io
from fastapi.testclient import TestClient
import pytest

from server import app


@pytest.fixture
def client():
    return TestClient(app)


def test_server_status(client):
    res = client.get("/api/status")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "online"
    assert "model" in data
    assert "files" in data


def test_server_upload_and_query_flow(client):
    # Reset first
    res = client.post("/api/reset")
    assert res.status_code == 200

    # Upload a document
    file_content = b"ACME Corporation Revenue in 2023 was $5,000,000. Operating costs were $3,200,000."
    file_obj = io.BytesIO(file_content)
    upload_res = client.post(
        "/api/upload",
        files={"file": ("acme_report.txt", file_obj, "text/plain")},
    )
    assert upload_res.status_code == 200
    upload_data = upload_res.json()
    assert upload_data["filename"] == "acme_report.txt"
    assert upload_data["status"] == "ok"
    assert upload_data["chunk_count"] >= 1

    # Verify document listed
    doc_res = client.get("/api/documents")
    assert doc_res.status_code == 200
    docs = doc_res.json()
    assert docs["count"] >= 1
    assert any(d["filename"] == "acme_report.txt" for d in docs["documents"])

    # Query the uploaded document
    query_res = client.post(
        "/api/query",
        json={"question": "What was the revenue of ACME Corporation in 2023?"},
    )
    assert query_res.status_code == 200
    query_data = query_res.json()
    assert "5,000,000" in query_data["answer"] or "revenue" in query_data["answer"].lower()
    assert len(query_data["citations"]) >= 1
    assert query_data["citations"][0]["filename"] == "acme_report.txt"

    # Delete the document
    del_res = client.delete("/api/documents/acme_report.txt")
    assert del_res.status_code == 200
    assert del_res.json()["status"] == "ok"

    # Verify document removed
    doc_res_after = client.get("/api/documents")
    assert doc_res_after.status_code == 200
    assert not any(d["filename"] == "acme_report.txt" for d in doc_res_after.json()["documents"])
