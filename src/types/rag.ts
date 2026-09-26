// Mirrors the enums and shapes defined in supabase/migrations/0002_rag_module.sql.
// Keep these in sync by hand until `supabase gen types typescript` is wired up.

export type DocStatus = "pending_upload" | "queued" | "processing" | "ready" | "failed";

export type DocStage =
  | "uploaded"
  | "classifying"
  | "extracting"
  | "contextualizing"
  | "chunking"
  | "embedding"
  | "done"
  | "failed";

export type DocKind =
  | "lecture_slides"
  | "textbook_chapter"
  | "research_paper"
  | "handwritten_notes"
  | "scanned_worksheet"
  | "exam_paper"
  | "table_dataset"
  | "diagram_image"
  | "plain_text"
  | "generic_text"
  | "unknown";

export type DocPipeline =
  | "native_text"
  | "vision_ocr"
  | "image_single"
  | "plain_text"
  | "spreadsheet"
  | "office_doc"
  | "presentation";

export type MessageRole = "user" | "assistant";

export type AnswerVerdict =
  | "answered"
  | "partial"
  | "insufficient_evidence"
  | "conflicting_evidence"
  | "no_retrieval";

export interface DocumentProgress {
  stage: string;
  pct: number;
  pages_done?: number;
  pages_total?: number;
  chunks_done?: number;
  chunks_total?: number;
  [key: string]: unknown;
}

export interface DocumentRow {
  id: string;
  owner_id: string;
  file_id: string | null;
  source: "direct" | "vault";
  title: string;
  source_filename: string;
  mime_type: string;
  size_bytes: number;
  storage_key: string;
  checksum_sha256: string;

  status: DocStatus;
  stage: DocStage;
  progress_pct: number;
  stage_detail: string | null;
  error: string | null;
  attempts: number;

  doc_kind: DocKind | null;
  pipeline: DocPipeline | null;
  classification_confidence: number | null;
  classification_reason: string | null;

  page_count: number | null;
  language: string | null;
  doc_summary: string | null;
  outline: unknown[];
  metadata: Record<string, unknown>;
  chunk_count: number;

  created_at: string;
  updated_at: string;
}

export interface IngestionEventRow {
  id: number;
  document_id: string;
  stage: DocStage;
  status: "started" | "ok" | "error";
  detail: string | null;
  ms: number | null;
  created_at: string;
}
