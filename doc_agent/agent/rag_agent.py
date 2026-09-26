"""
DocumentIntelligenceAgent
-------------------------
The orchestrator that ties everything together:

    ingest(file_path)              -> routes -> extracts -> chunks -> embeds -> stores
    query(question, session_id)    -> condenses (using history) -> retrieves
                                       -> builds grounded prompt -> calls LLM
                                       -> validates -> returns AgentResponse

Anti-fabrication is enforced at THREE layers, not just a prompt instruction:
    1. Retrieval gate    - if nothing relevant is retrieved (distance/score
                            below threshold), we never even call the LLM;
                            we return the "insufficient evidence" response.
    2. Prompt contract   - system prompt forces citation-per-claim and an
                            explicit escape hatch ("insufficient information").
    3. Post-hoc validator - checks the generated answer's claims actually
                            overlap with retrieved chunk text; flags/rejects
                            ungrounded answers rather than trusting the LLM
                            blindly.
"""

import os
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Optional
from uuid import uuid4

from .chunker import Chunk, chunk_raw
from .extractors import run_pipeline
from .gemini_client import BaseLLMClient, GeminiClient, _keywords
from .router import DocumentRouter, PipelineType
from .vector_store import VectorStore
from .xlsx_engine import XLSXIntelligenceEngine, XLSXStatus, XLSXResponse
from .ocr_agent import OCRAgent, OCRResponse, OCRDocumentMetadata

try:
    from access_control import visible_file_ids_for
    from db import get_db, log_audit
except ImportError:
    from .access_control import visible_file_ids_for  # type: ignore
    from ..db import get_db, log_audit  # type: ignore

CONFLICT_RESOLVER_API_KEY = (
    os.environ.get("CONFLICT_RESOLVER_API_KEY")
    or os.environ.get("GEMINI_API_KEY")
    or ""
)

CONFLICT_SYSTEM_PROMPT = """You are an Advanced LLM Search and Conflict Resolution Engine.
Your task is to analyze contradictory data, opposing policy versions, or multi-source discrepancies from the user's uploaded documents and datasets.

Your Objectives:
1. Identify the root cause of the conflict (e.g. differing document dates/revisions, separate departments, different sheet versions).
2. Synthesize all perspectives and evidence objectively.
3. Provide the OPTIMAL, recommended resolution based on authority, recency, and best domain practices.

Format your response cleanly using Markdown:
- ⚖️ **Conflict Identified**: Concise breakdown of the contradictory claims.
- 🔍 **Root Cause & Evidence Analysis**: Why the disagreement occurred across sources.
- 💡 **Optimal Resolution & Recommendation**: The definitive, authoritative recommended answer.
"""

RETRIEVAL_TOP_K = 6
# Chroma returns L2 distance on normalized vectors; smaller = more similar.
# Anything worse than this is treated as "not actually relevant".
MAX_RELEVANT_DISTANCE = 1.7
MIN_VALIDATOR_OVERLAP = 0.15  # fraction of answer keywords that must appear in retrieved context

INSUFFICIENT_EVIDENCE_MSG = (
    "I don't have enough information in the uploaded documents to answer that question."
)

SYSTEM_PROMPT = """You are a document intelligence assistant. You must answer
STRICTLY and ONLY using the CONTEXT provided below, which was retrieved from
the user's uploaded documents.

Rules (non-negotiable):
1. Do not use any outside knowledge. If the context does not contain the
   answer, say exactly: "I don't have enough information in the uploaded
   documents to answer that question."
2. Every factual claim must be followed by a citation tag in the form
   [filename, page X] copied from the context's source markers.
3. If different sources in the context disagree, explicitly say so and
   present both versions with their citations, instead of picking one.
4. Never invent a filename, page number, or fact that is not in the context.
"""


@dataclass
class AgentResponse:
    answer: str
    citations: List[dict]
    grounded: bool
    insufficient_evidence: bool
    conflicting: bool
    retrieved_chunks: List[dict] = field(default_factory=list)
    status: str = "verified"
    evidence: List[dict] = field(default_factory=list)
    clarification_options: Optional[List[str]] = None


@dataclass
class ConversationTurn:
    question: str
    answer: str


class DocumentIntelligenceAgent:
    def __init__(self, llm_client: BaseLLMClient, persist_dir: Optional[str] = None):
        self.llm = llm_client
        self.router = DocumentRouter()
        self.store = VectorStore(persist_dir=persist_dir)
        self.xlsx_engine = XLSXIntelligenceEngine(llm_client=self.llm)
        self.ocr_agent = OCRAgent(llm_client=self.llm)
        self.sessions: dict[str, List[ConversationTurn]] = {}

    # ---------------------------------------------------------- ingestion
    def ingest(
        self,
        file_path: str,
        doc_id: Optional[str] = None,
        owner_id: str = "default_user",
        db: Optional[sqlite3.Connection] = None,
        original_filename: Optional[str] = None,
    ) -> dict:
        decision = self.router.route(file_path)
        if decision.pipeline == PipelineType.UNSUPPORTED:
            return {"status": "rejected", "reason": decision.reason, "file_path": file_path}

        doc_id = doc_id or str(uuid4())
        vision_fn = self._vision_fn if decision.pipeline in (
            PipelineType.SCANNED_PDF, PipelineType.IMAGE, PipelineType.OCR
        ) else None

        raw_chunks = run_pipeline(decision, doc_id, vision_fn=vision_fn)
        chunks: List[Chunk] = chunk_raw(raw_chunks)

        if not chunks:
            return {
                "status": "empty",
                "reason": "Pipeline ran but produced no extractable content",
                "pipeline": decision.pipeline.value,
                "file_path": file_path,
            }

        # Use original display filename for chunk metadata and citations if available
        conn = db or get_db()
        display_name = original_filename
        if not display_name:
            try:
                cursor = conn.cursor()
                cursor.execute("SELECT filename FROM files WHERE id = ?", (doc_id,))
                row = cursor.fetchone()
                if row and row["filename"]:
                    display_name = row["filename"]
            except Exception:
                pass

        if display_name:
            for c in chunks:
                c.filename = display_name

        texts = [c.text for c in chunks]
        embeddings: Any = self.llm.embed(texts)
        self.store.add(chunks, embeddings)

        ext = Path(file_path).suffix.lower()
        xlsx_meta = None
        if ext in (".xlsx", ".xls", ".xlsm", ".xlsb", ".csv", ".tsv") or decision.pipeline in (PipelineType.EXCEL, PipelineType.CSV):
            try:
                wb_meta = self.xlsx_engine.inspect(file_path)
                xlsx_meta = wb_meta.to_dict()
                setattr(self.xlsx_engine, "current_workbook_doc_id", doc_id)
            except Exception:
                pass

        ocr_meta = None
        if decision.pipeline in (PipelineType.SCANNED_PDF, PipelineType.IMAGE, PipelineType.OCR) or ext in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".gif", ".ico", ".svg"):
            try:
                doc_ocr = self.ocr_agent.ingest(file_path)
                ocr_meta = doc_ocr.to_dict()
                setattr(self.ocr_agent, "current_document_doc_id", doc_id)
            except Exception:
                pass

        # Update or record file in SQLite files table
        conn = db or get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM files WHERE id = ?", (doc_id,))
        existing = cursor.fetchone()
        now_iso = datetime.now(timezone.utc).isoformat()
        if not existing:
            with conn:
                conn.execute(
                    """
                    INSERT INTO files (
                        id, owner_id, filename, storage_path, pipeline,
                        visibility, status, chunk_count, uploaded_at, deleted_at
                    ) VALUES (?, ?, ?, ?, ?, 'private', 'active', ?, ?, NULL)
                    """,
                    (
                        doc_id,
                        owner_id,
                        Path(file_path).name,
                        os.path.abspath(file_path),
                        decision.pipeline.value,
                        len(chunks),
                        now_iso,
                    ),
                )
        else:
            with conn:
                conn.execute(
                    "UPDATE files SET chunk_count = ?, pipeline = ? WHERE id = ?",
                    (len(chunks), decision.pipeline.value, doc_id),
                )

        result_payload: dict[str, Any] = {
            "status": "ok",
            "doc_id": doc_id,
            "pipeline": decision.pipeline.value,
            "reason": decision.reason,
            "chunk_count": len(chunks),
            "file_path": file_path,
        }
        if xlsx_meta:
            result_payload["xlsx_metadata"] = xlsx_meta
        if ocr_meta:
            result_payload["ocr_metadata"] = ocr_meta
        return result_payload

    def _vision_fn(self, image_bytes: bytes, prompt: str) -> str:
        return self.llm.vision_transcribe(image_bytes, prompt)

    def delete_document(self, filename: str) -> bool:
        self.store.delete_by_filename(filename)
        if self.xlsx_engine.current_workbook and (
            Path(self.xlsx_engine.current_workbook.file_path).name == filename
        ):
            self.xlsx_engine.current_workbook = None
            self.xlsx_engine.current_dataframes = {}
        if self.ocr_agent.current_document and (
            Path(self.ocr_agent.current_document.file_path).name == filename
        ):
            self.ocr_agent.current_document = None
        return True

    # ------------------------------------------------------------- query
    def query(
        self,
        question: str,
        session_id: str = "default",
        user_id: Optional[str] = None,
        db: Optional[sqlite3.Connection] = None,
    ) -> AgentResponse:
        conn = db or get_db()
        effective_user_id = user_id or "default_user"
        allowed_file_ids = visible_file_ids_for(effective_user_id, conn)

        # Audit log the query
        log_audit(
            actor_id=effective_user_id,
            action="query",
            detail=question[:500],
            db=conn,
        )

        history = self.sessions.setdefault(session_id, [])

        # If user has no visible files in scope, refuse immediately with insufficient evidence
        if not allowed_file_ids:
            response = AgentResponse(
                answer=INSUFFICIENT_EVIDENCE_MSG,
                citations=[],
                grounded=True,
                insufficient_evidence=True,
                conflicting=False,
                retrieved_chunks=[],
                status="insufficient_information",
            )
            history.append(ConversationTurn(question, response.answer))
            return response

        standalone_question = self._condense_question(question, history)

        # 1. Primary Tabular Route: If a workbook is active and permitted for this user
        wb_doc_id = getattr(self.xlsx_engine, "current_workbook_doc_id", None)
        if self.xlsx_engine.current_workbook is not None and (wb_doc_id is None or wb_doc_id in allowed_file_ids):
            xlsx_resp = self.xlsx_engine.query(standalone_question, session_id=session_id)
            if xlsx_resp.status in (
                XLSXStatus.VERIFIED,
                XLSXStatus.CLARIFICATION_REQUIRED,
                XLSXStatus.CONFLICTING_INFORMATION,
            ):
                citations = []
                for ev in xlsx_resp.evidence:
                    citations.append({
                        "filename": ev.get("file", self.xlsx_engine.current_workbook.filename),
                        "page": ev.get("sheet", "Data"),
                        "chunk_type": "table_cell" if "cell" in ev else "table_aggregate",
                        "snippet": f"Sheet: {ev.get('sheet')}, Operation: {ev.get('operation')}, Columns: {ev.get('columns')}, Rows: {ev.get('rows_analyzed')}",
                    })
                response = AgentResponse(
                    answer=xlsx_resp.answer,
                    citations=citations,
                    grounded=(xlsx_resp.status == XLSXStatus.VERIFIED),
                    insufficient_evidence=False,
                    conflicting=(xlsx_resp.status == XLSXStatus.CONFLICTING_INFORMATION),
                    retrieved_chunks=[],
                    status=xlsx_resp.status.value,
                    evidence=xlsx_resp.evidence,
                    clarification_options=xlsx_resp.clarification_options,
                )
                history.append(ConversationTurn(question, response.answer))
                return response
            elif xlsx_resp.status == XLSXStatus.INSUFFICIENT_INFORMATION:
                # Check if we have other non-tabular documents in vector store
                has_other_docs = False
                try:
                    get_res: Any = self.store.collection.get(include=["metadatas"])
                    all_meta = get_res.get("metadatas") or []
                    for m in all_meta:
                        if m and isinstance(m, dict):
                            fn = str(m.get("filename") or "").lower()
                            if not any(fn.endswith(e) for e in [".xlsx", ".xls", ".csv", ".tsv"]):
                                has_other_docs = True
                                break
                except Exception:
                    pass

                # If no other prose docs, or question is clearly analytical, return tabular refusal
                q_low = standalone_question.lower()
                is_analytical = any(w in q_low for w in ["row", "column", "sheet", "average", "mean", "median", "mode", "sum", "total", "min", "max", "variance", "std", "count", "correlation", "percent", "filter"])
                if not has_other_docs or is_analytical:
                    response = AgentResponse(
                        answer=xlsx_resp.answer,
                        citations=[],
                        grounded=False,
                        insufficient_evidence=True,
                        conflicting=False,
                        retrieved_chunks=[],
                        status=xlsx_resp.status.value,
                        evidence=xlsx_resp.evidence,
                        clarification_options=xlsx_resp.clarification_options,
                    )
                    history.append(ConversationTurn(question, response.answer))
                    return response

        # 2. Vector Retrieval Route for unstructured prose documents
        q_embedding: Any = self.llm.embed(standalone_question)
        retrieved = self.store.query(q_embedding, k=RETRIEVAL_TOP_K, allowed_file_ids=allowed_file_ids)

        relevant = [r for r in retrieved if r["distance"] is None or r["distance"] <= MAX_RELEVANT_DISTANCE]

        if not relevant:
            response = AgentResponse(
                answer=INSUFFICIENT_EVIDENCE_MSG,
                citations=[],
                grounded=True,
                insufficient_evidence=True,
                conflicting=False,
                retrieved_chunks=retrieved,
                status="insufficient_information",
            )
            history.append(ConversationTurn(question, response.answer))
            return response

        context_block, citation_list = self._build_context(relevant)
        user_prompt = f"CONTEXT:\n{context_block}\nQUESTION:\n{standalone_question}"

        raw_answer = self.llm.generate(SYSTEM_PROMPT, user_prompt)

        grounded, overlap_ratio = self._validate_grounding(raw_answer, relevant)
        insufficient = self._looks_like_refusal(raw_answer)
        conflicting = self._looks_conflicting(raw_answer)

        if not grounded and not insufficient:
            final_answer = (
                INSUFFICIENT_EVIDENCE_MSG
                + " (Generated answer failed grounding verification and was withheld.)"
            )
            insufficient = True
        else:
            final_answer = raw_answer

        response = AgentResponse(
            answer=final_answer,
            citations=citation_list if not insufficient else [],
            grounded=grounded,
            insufficient_evidence=insufficient,
            conflicting=conflicting,
            retrieved_chunks=relevant,
            status="verified" if (grounded and not insufficient) else "insufficient_information",
        )
        history.append(ConversationTurn(question, response.answer))
        return response

    # ------------------------------------------------------------ helpers
    def _condense_question(self, question: str, history: List[ConversationTurn]) -> str:
        if not history:
            return question
        q_clean = question.strip()
        q_low = q_clean.lower()
        words = set(re.findall(r"[a-z']+", q_low))
        pronouns = {"it", "its", "that", "this", "those", "these", "he", "she", "they", "them", "their"}
        connectors = ("and ", "also ", "what about", "how about", "why ")
        
        # Only condense if the question has an explicit dependent pronoun or connector follow-up
        is_dependent = bool(words & pronouns) or any(q_low.startswith(c) for c in connectors)
        if is_dependent:
            last_turn = history[-1].question
            return f"{last_turn} {q_clean}"
        return q_clean

    def _build_context(self, retrieved: List[dict]):
        blocks = []
        citations = []
        for r in retrieved:
            meta = r["metadata"]
            tag = f"[{meta['filename']}, page {meta['page_num']}]"
            blocks.append(f"{tag}\n{r['text']}")
            citations.append({
                "filename": meta["filename"],
                "page": meta["page_num"],
                "chunk_type": meta["chunk_type"],
                "snippet": r["text"][:200],
            })
        return "\n---\n".join(blocks), citations

    def _validate_grounding(self, answer: str, retrieved: List[dict]):
        if self._looks_like_refusal(answer):
            return True, 1.0
        answer_kw = _keywords(answer)
        if not answer_kw:
            return False, 0.0
        context_kw = set()
        for r in retrieved:
            context_kw |= _keywords(r["text"])
        overlap = len(answer_kw & context_kw) / len(answer_kw)
        return overlap >= MIN_VALIDATOR_OVERLAP, overlap

    def _looks_like_refusal(self, answer: str) -> bool:
        return "don't have enough information" in answer.lower() or "insufficient information" in answer.lower()

    def _looks_conflicting(self, answer: str) -> bool:
        markers = ["conflict", "disagree", "however, another source", "contradicts", "differs from"]
        low = answer.lower()
        return any(m in low for m in markers)

    def resolve_conflict_with_llm(
        self,
        question: str,
        answer_context: Optional[str] = None,
        api_key: Optional[str] = None,
        user_id: Optional[str] = None,
        db: Optional[sqlite3.Connection] = None,
    ) -> dict:
        """
        Uses an LLM Search / Resolution call with a dedicated API key
        to analyze conflicting evidence and determine the optimal answer.
        """
        key = api_key or os.environ.get("CONFLICT_RESOLVER_API_KEY", CONFLICT_RESOLVER_API_KEY)
        conn = db or get_db()
        effective_user_id = user_id or "default_user"
        allowed_file_ids = visible_file_ids_for(effective_user_id, conn)

        # Gather relevant context from active workbook, recent conversation, or vector store
        context_parts = []
        if answer_context:
            context_parts.append(f"Previous Agent Answer & Discovered Discrepancy:\n{answer_context}")

        # Check if active workbook has conflicting information
        wb_doc_id = getattr(self.xlsx_engine, "current_workbook_doc_id", None)
        if (
            self.xlsx_engine.current_workbook
            and (wb_doc_id is None or wb_doc_id in allowed_file_ids)
            and self.xlsx_engine.current_workbook.sheet_count >= 2
        ):
            wb = self.xlsx_engine.current_workbook
            conflict_res = self.xlsx_engine._check_conflicting_information(question, question.lower(), wb)
            if conflict_res:
                context_parts.append(f"Spreadsheet Discrepancy Detected:\n{conflict_res.answer}")

        # Also retrieve top matching chunks from vector store using access control filter
        try:
            q_emb: Any = self.llm.embed(question)
            retrieved = self.store.query(q_emb, k=6, allowed_file_ids=allowed_file_ids)
            if retrieved:
                doc_ctx, _ = self._build_context(retrieved)
                context_parts.append(f"Document Sources & Citations:\n{doc_ctx}")
        except Exception:
            pass

        full_context = "\n\n".join(context_parts) or "No additional raw text context found."

        user_prompt = (
            f"QUESTION:\n{question}\n\n"
            f"EVIDENCE & CONTEXT:\n{full_context}\n\n"
            "Please analyze the conflicting data, evaluate the root causes, and provide the optimal, recommended resolution."
        )

        try:
            resolver_client = GeminiClient(api_key=key)
            resolution = resolver_client.generate(CONFLICT_SYSTEM_PROMPT, user_prompt)
            return {
                "status": "resolved",
                "question": question,
                "answer": resolution,
                "engine": "Gemini LLM Search & Conflict Resolver",
                "key_used_prefix": key[:8] + "...",
            }
        except Exception as e:
            # Fallback to current LLM if custom key has network or quota error
            resolution = self.llm.generate(CONFLICT_SYSTEM_PROMPT, user_prompt)
            return {
                "status": "resolved",
                "question": question,
                "answer": resolution,
                "engine": "Fallback LLM Engine",
                "error_note": str(e),
            }
