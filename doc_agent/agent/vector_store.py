"""
Vector store wrapper (Chroma, in-process/local -- no server to stand up).
Kept thin on purpose: add(chunks, embeddings) and query(embedding, k).
"""

from typing import Any, List, Optional
from uuid import uuid4

import chromadb

from .chunker import Chunk


class VectorStore:
    def __init__(self, collection_name: Optional[str] = None, persist_dir: Optional[str] = None):
        # IMPORTANT: chromadb's EphemeralClient caches its underlying System
        # by settings hash, so two EphemeralClient() instances in the same
        # process can silently share state if given the same collection
        # name. Default to a unique collection name per VectorStore instance
        # so separate agents (e.g. separate test cases, separate demo
        # sessions) are properly isolated. Pass an explicit collection_name
        # when you deliberately want persistence/sharing across instances.
        collection_name = collection_name or f"documents_{uuid4().hex[:12]}"
        if persist_dir:
            self.client = chromadb.PersistentClient(path=persist_dir)
        else:
            self.client = chromadb.EphemeralClient()
        self.collection = self.client.get_or_create_collection(collection_name)

    def add(self, chunks: List[Chunk], embeddings: Any):
        if not chunks:
            return
        self.collection.add(
            ids=[c.id for c in chunks],
            embeddings=embeddings,
            documents=[c.text for c in chunks],
            metadatas=[{
                "doc_id": c.doc_id,
                "filename": c.filename,
                "page_num": c.page_num,
                "chunk_type": c.chunk_type,
                "section": c.section,
            } for c in chunks],
        )

    def query(self, query_embedding: Any, k: int = 6, allowed_file_ids: Optional[List[str]] = None) -> List[dict]:
        """
        If allowed_file_ids is provided, add a Chroma `where` filter:
            where={"doc_id": {"$in": allowed_file_ids}}
        so retrieval NEVER returns chunks belonging to files the caller isn't
        permitted to see. If allowed_file_ids is None, do NOT default to
        "return everything" -- treat None as "caller forgot to pass
        permissions" and raise, forcing every call site to be explicit.
        """
        if allowed_file_ids is None:
            raise ValueError(
                "allowed_file_ids must be explicitly provided -- caller forgot to pass permissions"
            )
        if len(allowed_file_ids) == 0 or self.collection.count() == 0:
            return []

        k = min(k, self.collection.count())
        where_filter = {"doc_id": {"$in": allowed_file_ids}}
        res = self.collection.query(
            query_embeddings=[query_embedding],
            n_results=k,
            where=where_filter,
        )
        results = []
        for i in range(len(res["ids"][0])):
            results.append({
                "id": res["ids"][0][i],
                "text": res["documents"][0][i],
                "metadata": res["metadatas"][0][i],
                "distance": res["distances"][0][i] if res.get("distances") else None,
            })
        return results

    def delete_by_doc_id(self, doc_id: str):
        if self.collection.count() == 0:
            return
        try:
            self.collection.delete(where={"doc_id": doc_id})
        except Exception:
            pass

    def delete_by_filename(self, filename: str):
        if self.collection.count() == 0:
            return
        try:
            self.collection.delete(where={"filename": filename})
        except Exception:
            pass

    def reset(self):
        self.client.delete_collection(self.collection.name)
        self.collection = self.client.get_or_create_collection(self.collection.name)
