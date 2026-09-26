import { createAdminClient } from "@/lib/supabase/admin";
import { getObjectBytes } from "@/lib/storage";
import { uploadAndWaitActive } from "@/lib/gemini/files";
import { classifyAndExtract, classifyExtractedText, extractPlainText, type ClassifyExtractResult } from "./classify_extract";
import { extractCsv, extractDocx, extractPptx, extractXlsx } from "./office";
import { resolveFormat } from "./formats";
import { contextualizeDocument, templatedContext, assembleContextHeader, type DocContext } from "./contextualize";
import { chunkDocument } from "./chunk";
import { embedDocuments } from "@/lib/gemini/embed";
import { GEMINI_EMBED_MODEL } from "@/lib/gemini/models";
import type { DocStage } from "@/types/rag";

/**
 * The single entry point for ingesting one document.
 *
 * Signature is deliberately (documentId: string) => Promise<void> -- no
 * request, no cookies, nothing tied to the HTTP call that triggered it. That
 * is the liftability contract: moving this from an in-process `after()` call
 * into a real background worker later is a matter of importing this same
 * function from a different caller, not rewriting it.
 */
export async function runIngestion(documentId: string): Promise<void> {
  const db = createAdminClient();

  // Atomic claim -- see claim_document_for_ingestion() in
  // 0003_rag_functions.sql. A false return means another worker already holds
  // this document, or it is not in a claimable state (already ready, or
  // failed with no retries left). Either way, exit quietly.
  const { data: claimed, error: claimError } = await db.rpc("claim_document_for_ingestion", {
    p_document_id: documentId,
  });
  if (claimError) {
    console.error(`[ingest ${documentId}] claim RPC failed:`, claimError.message);
    return;
  }
  if (!claimed) return;

  const { data: doc, error: fetchError } = await db
    .from("documents")
    .select("owner_id, storage_key, mime_type, source_filename")
    .eq("id", documentId)
    .single();
  if (fetchError || !doc) {
    console.error(`[ingest ${documentId}] claimed but row is gone`);
    return;
  }
  const ownerId = doc.owner_id as string;

  try {
    if (!process.env.GEMINI_API_KEY) {
      await runStub(db, documentId, ownerId);
      return;
    }

    await runReal(db, documentId, ownerId, doc.storage_key, doc.mime_type, doc.source_filename);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest ${documentId}] failed:`, message);
    await db
      .from("documents")
      .update({ status: "failed", stage: "failed", error: message.slice(0, 500) })
      .eq("id", documentId);
    await logEvent(db, documentId, ownerId, "failed", "error", message.slice(0, 500));
  }
}

type AdminClient = ReturnType<typeof createAdminClient>;

// Chunk-count guardrail from the design: per-document contextualization is
// one call regardless of document size, but if a document produces an
// unusually large number of chunks, even that one call's ~60k-char input cap
// stops representing the document well, and it's cheaper and just as useful
// to fall back to the templated header for chunks past this scale.
const MAX_CHUNKS_FOR_LLM_CONTEXT = 400;

async function runReal(
  db: AdminClient,
  documentId: string,
  ownerId: string,
  storageKey: string,
  mimeType: string,
  filename: string
) {
  await setStage(db, documentId, "classifying", 10);
  const bytes = await getObjectBytes(storageKey);

  const format = resolveFormat(filename, mimeType)?.format;
  let extracted: ClassifyExtractResult;
  switch (format) {
    case "xlsx":
      extracted = await classifyExtractedText(await extractXlsx(bytes), filename, "spreadsheet", {
        docKind: "table_dataset",
        reason: "Excel workbook: each sheet read directly as structured tables.",
      });
      break;
    case "csv":
      extracted = await classifyExtractedText(extractCsv(bytes, filename), filename, "spreadsheet", {
        docKind: "table_dataset",
        reason: "Delimited data file: parsed directly into row-group tables.",
      });
      break;
    case "pptx":
      extracted = await classifyExtractedText(await extractPptx(bytes), filename, "presentation", {
        docKind: "lecture_slides",
        reason: "PowerPoint deck: one page per slide, including speaker notes.",
      });
      break;
    case "docx":
      extracted = await classifyExtractedText(await extractDocx(bytes), filename, "office_doc");
      break;
    case "text":
      extracted = await classifyExtractedText(extractPlainText(bytes), filename, "plain_text");
      break;
    default: {
      const { uri } = await uploadAndWaitActive(bytes, mimeType, filename);
      extracted = await classifyAndExtract(uri, mimeType, filename);
    }
  }
  if (extracted.pages.length === 0) throw new Error("No extractable content found in this file.");
  await logEvent(db, documentId, ownerId, "classifying", "ok", `${extracted.docKind} / ${extracted.pipeline}`);

  await db
    .from("documents")
    .update({
      doc_kind: extracted.docKind,
      pipeline: extracted.pipeline,
      classification_confidence: extracted.confidence,
      classification_reason: extracted.reason,
      language: extracted.language,
      title: extracted.title || filename,
      page_count: extracted.pageCount,
      metadata: { page_meta: extracted.pageMeta },
    })
    .eq("id", documentId);

  await setStage(db, documentId, "extracting", 40, `${extracted.pages.length} page(s) transcribed`);
  await logEvent(db, documentId, ownerId, "extracting", "ok", `${extracted.pages.length} pages`);

  await setStage(db, documentId, "chunking", 60);
  const chunks = chunkDocument(extracted.pages, extracted.docKind);
  if (chunks.length === 0) throw new Error("Chunking produced zero chunks -- nothing to index.");
  await logEvent(db, documentId, ownerId, "chunking", "ok", `${chunks.length} chunks`);

  await setStage(db, documentId, "contextualizing", 75);
  let ctx: DocContext;
  const totalChars = extracted.pages.reduce((sum, p) => sum + p.markdown.length, 0);
  if (chunks.length > MAX_CHUNKS_FOR_LLM_CONTEXT || totalChars < 500) {
    ctx = templatedContext(extracted.title || filename, extracted.docKind);
  } else {
    try {
      ctx = await contextualizeDocument(extracted.pages, extracted.title || filename, extracted.docKind);
    } catch (err) {
      console.warn(`[ingest ${documentId}] contextualize failed, falling back to templated:`, err);
      ctx = templatedContext(extracted.title || filename, extracted.docKind);
    }
  }
  await db.from("documents").update({ doc_summary: ctx.docSummary, outline: ctx.sections }).eq("id", documentId);
  await logEvent(db, documentId, ownerId, "contextualizing", "ok");

  const contextHeaders = chunks.map((c) => assembleContextHeader(c, ctx, extracted.title || filename, extracted.docKind));

  await setStage(db, documentId, "embedding", 90);
  const embedInputs = chunks.map((c, i) => `${contextHeaders[i]}\n\n${c.content}`);
  const vectors = await embedDocuments(embedInputs, extracted.title || filename);
  await logEvent(db, documentId, ownerId, "embedding", "ok", `${vectors.length} vectors`);

  const rows = chunks.map((c, i) => ({
    document_id: documentId,
    owner_id: ownerId,
    chunk_index: c.chunkIndex,
    content: c.content,
    contextual_text: contextHeaders[i],
    content_kind: c.contentKind,
    page_from: c.pageFrom,
    page_to: c.pageTo,
    section_path: c.sectionPath,
    heading: c.heading,
    token_count: c.tokenCount,
    embedding: vectors[i],
    embedding_model: GEMINI_EMBED_MODEL,
  }));

  // Clear any prior generation's chunks before writing the new one -- keeps
  // a reprocess idempotent rather than accumulating duplicates alongside a
  // changed chunk_index numbering.
  await db.from("chunks").delete().eq("document_id", documentId);
  const { error: chunksError } = await db.from("chunks").insert(rows);
  if (chunksError) throw new Error(`Failed to write chunks: ${chunksError.message}`);

  await db
    .from("documents")
    .update({
      status: "ready",
      stage: "done",
      progress_pct: 100,
      stage_detail: null,
      chunk_count: rows.length,
      ingest_finished_at: new Date().toISOString(),
    })
    .eq("id", documentId);
  await logEvent(db, documentId, ownerId, "done", "ok", `${rows.length} chunks indexed`);
}

async function setStage(db: AdminClient, documentId: string, stage: DocStage, pct: number, detail?: string) {
  await db.from("documents").update({ stage, progress_pct: pct, stage_detail: detail ?? null }).eq("id", documentId);
}

// --- Stub, used only when GEMINI_API_KEY is absent --------------------------

const STUB_STAGES: Array<{ stage: DocStage; pct: number; ms: number }> = [
  { stage: "classifying", pct: 15, ms: 500 },
  { stage: "extracting", pct: 45, ms: 900 },
  { stage: "contextualizing", pct: 65, ms: 500 },
  { stage: "chunking", pct: 80, ms: 400 },
  { stage: "embedding", pct: 95, ms: 500 },
];

const STUB_DETAIL = "Stub run — set GEMINI_API_KEY to ingest real content.";

async function runStub(db: AdminClient, documentId: string, ownerId: string) {
  for (const step of STUB_STAGES) {
    await sleep(step.ms);
    await db
      .from("documents")
      .update({ stage: step.stage, progress_pct: step.pct, stage_detail: STUB_DETAIL })
      .eq("id", documentId);
    await logEvent(db, documentId, ownerId, step.stage, "ok", STUB_DETAIL, step.ms);
  }

  await db
    .from("documents")
    .update({
      status: "ready",
      stage: "done",
      progress_pct: 100,
      stage_detail: STUB_DETAIL,
      chunk_count: 0,
      ingest_finished_at: new Date().toISOString(),
    })
    .eq("id", documentId);
  await logEvent(db, documentId, ownerId, "done", "ok", STUB_DETAIL);
}

async function logEvent(
  db: AdminClient,
  documentId: string,
  ownerId: string,
  stage: DocStage,
  status: "started" | "ok" | "error",
  detail?: string,
  ms?: number
) {
  await db.from("ingestion_events").insert({
    document_id: documentId,
    owner_id: ownerId,
    stage,
    status,
    detail: detail ?? null,
    ms: ms ?? null,
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
