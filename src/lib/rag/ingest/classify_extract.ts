import { Type, createUserContent, createPartFromUri, type Schema } from "@google/genai";
import { generateJson } from "@/lib/gemini/json";
import { GEMINI_PARSE_MODEL, GEMINI_FAST_MODEL } from "@/lib/gemini/models";
import type { DocKind, DocPipeline } from "@/types/rag";
import type { ExtractedPage } from "./chunk";

/**
 * Classification and extraction in ONE Gemini call rather than two.
 *
 * The textbook design classifies from the first few pages, THEN routes to a
 * separate extraction call (and separately again to a text-layer heuristic
 * that decides native_text vs vision_ocr). Collapsing all of that into one
 * call is possible specifically because Gemini reads a PDF's native text
 * layer AND does vision OCR on scanned pages in the same request, at no
 * extra token cost for the native-text case -- so there is no cheaper "fast
 * path" call to fall back to; the vision call already IS the fast path.
 *
 * `pipeline` is still recorded per document because it drives chunking policy
 * (see chunk.ts's lecture_slides branch) and is shown in the UI as proof the
 * system actually routed different document types differently -- but for
 * PDFs specifically, native_text and vision_ocr are two LABELS applied to the
 * same transport, derived from the model's self-reported text_layer, not two
 * different code paths. image_single and plain_text ARE genuinely different
 * paths (see extract.ts).
 */

export interface ClassifyExtractResult {
  docKind: DocKind;
  textLayer: "born_digital" | "scanned" | "mixed" | "none";
  pipeline: DocPipeline;
  confidence: number;
  reason: string;
  language: string | null;
  title: string | null;
  pageCount: number;
  pages: ExtractedPage[];
  pageMeta: Array<{ pageNo: number; hasTables: boolean; hasFigures: boolean; isNoisy: boolean; ocrConfidence: number }>;
}

const DOC_KINDS: DocKind[] = [
  "lecture_slides", "textbook_chapter", "research_paper", "handwritten_notes",
  "scanned_worksheet", "exam_paper", "table_dataset", "diagram_image",
  "plain_text", "generic_text", "unknown",
];

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  required: ["doc_kind", "text_layer", "confidence", "reason", "page_count", "pages"],
  properties: {
    doc_kind: { type: Type.STRING, enum: DOC_KINDS, format: "enum" },
    text_layer: { type: Type.STRING, enum: ["born_digital", "scanned", "mixed", "none"], format: "enum" },
    confidence: { type: Type.NUMBER, minimum: 0, maximum: 1 },
    reason: { type: Type.STRING, description: "One sentence: why this classification." },
    language: { type: Type.STRING, nullable: true },
    title: { type: Type.STRING, nullable: true, description: "The document's own title, not the filename." },
    page_count: { type: Type.INTEGER },
    pages: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        required: ["page_no", "markdown", "has_tables", "has_figures", "is_noisy", "ocr_confidence"],
        properties: {
          page_no: { type: Type.INTEGER },
          markdown: {
            type: Type.STRING,
            description:
              "Full content of this page as GitHub-flavoured markdown. Preserve heading " +
              "hierarchy with # / ## / ###. Render every table as a markdown table, never as " +
              "prose. Use $...$ / $$...$$ for math. For figures use ![figure: description]. " +
              "If this is a noisy scan, transcribe exactly what is legible and mark illegible " +
              "spans as [illegible] -- never guess at a number, date, name or formula; an " +
              "[illegible] marker is always preferable to a plausible invention.",
          },
          has_tables: { type: Type.BOOLEAN },
          has_figures: { type: Type.BOOLEAN },
          is_noisy: { type: Type.BOOLEAN, description: "True if this page is a low-quality scan or hard to read." },
          ocr_confidence: { type: Type.NUMBER, minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

interface RawResult {
  doc_kind: string;
  text_layer: string;
  confidence: number;
  reason: string;
  language?: string | null;
  title?: string | null;
  page_count: number;
  pages: Array<{
    page_no: number;
    markdown: string;
    has_tables: boolean;
    has_figures: boolean;
    is_noisy: boolean;
    ocr_confidence: number;
  }>;
}

function derivePipeline(mimeType: string, textLayer: RawResult["text_layer"]): DocPipeline {
  if (mimeType.startsWith("image/")) return "image_single";
  if (mimeType === "text/plain" || mimeType === "text/markdown" || mimeType === "text/csv") return "plain_text";
  return textLayer === "born_digital" ? "native_text" : "vision_ocr";
}

const PROMPT = `You are a document ingestion pipeline. Read the attached file and:

1. Classify it into exactly one doc_kind from the enum you were given.
2. Report whether it has a genuine embedded text layer (born_digital), is a
   scan with no usable text layer (scanned), has both in different sections
   (mixed), or has no text at all (none, e.g. a pure diagram).
3. Transcribe every page in full as markdown, following the per-page field
   instructions exactly.

Do not summarise or omit any page. Do not skip pages. If the document has N
pages, return exactly N entries in "pages", numbered 1..N in order.`;

export async function classifyAndExtract(
  fileUri: string,
  mimeType: string,
  filename: string
): Promise<ClassifyExtractResult> {
  const contents = createUserContent([PROMPT, createPartFromUri(fileUri, mimeType)]);

  const raw = await generateJson<RawResult>(GEMINI_PARSE_MODEL, contents, RESPONSE_SCHEMA);

  const docKind = (DOC_KINDS.includes(raw.doc_kind as DocKind) ? raw.doc_kind : "unknown") as DocKind;
  const textLayer = (["born_digital", "scanned", "mixed", "none"].includes(raw.text_layer)
    ? raw.text_layer
    : "none") as ClassifyExtractResult["textLayer"];

  const pages = raw.pages
    .slice()
    .sort((a, b) => a.page_no - b.page_no)
    .map((p) => ({ pageNo: p.page_no, markdown: p.markdown ?? "" }));

  return {
    docKind,
    textLayer,
    pipeline: derivePipeline(mimeType, textLayer),
    confidence: Math.min(1, Math.max(0, raw.confidence ?? 0)),
    reason: raw.reason || "",
    language: raw.language ?? null,
    title: raw.title || filename,
    pageCount: raw.page_count || pages.length,
    pages,
    pageMeta: raw.pages.map((p) => ({
      pageNo: p.page_no,
      hasTables: !!p.has_tables,
      hasFigures: !!p.has_figures,
      isNoisy: !!p.is_noisy,
      ocrConfidence: p.ocr_confidence ?? 1,
    })),
  };
}

export function extractPlainText(bytes: Uint8Array): ExtractedPage[] {
  return [{ pageNo: 1, markdown: Buffer.from(bytes).toString("utf-8").replace(/^﻿/, "") }];
}

const TEXT_CLASSIFY_SCHEMA: Schema = {
  type: Type.OBJECT,
  required: ["doc_kind", "confidence", "reason"],
  properties: {
    doc_kind: { type: Type.STRING, enum: DOC_KINDS, format: "enum" },
    confidence: { type: Type.NUMBER, minimum: 0, maximum: 1 },
    reason: { type: Type.STRING, description: "One sentence: why this classification." },
    language: { type: Type.STRING, nullable: true },
    title: { type: Type.STRING, nullable: true, description: "The document's own title, not the filename." },
  },
};

const CLASSIFY_SAMPLE_CHARS = 6000;

/**
 * Builds the result for formats whose text was extracted deterministically
 * (Office, CSV, plain text). Classification is still automatic: one cheap
 * call over a sample, unless the caller already knows the kind (spreadsheets
 * are table_dataset, decks are lecture_slides -- the latter also selects the
 * one-chunk-per-slide policy).
 */
export async function classifyExtractedText(
  pages: ExtractedPage[],
  filename: string,
  pipeline: DocPipeline,
  fixed?: { docKind: DocKind; reason: string }
): Promise<ClassifyExtractResult> {
  const base = {
    textLayer: "born_digital" as const,
    pipeline,
    pageCount: pages.length,
    pages,
    pageMeta: pages.map((p) => ({
      pageNo: p.pageNo,
      hasTables: /^\|.*\|$/m.test(p.markdown),
      hasFigures: false,
      isNoisy: false,
      ocrConfidence: 1,
    })),
  };

  if (fixed) {
    return { ...base, docKind: fixed.docKind, confidence: 1, reason: fixed.reason, language: null, title: filename };
  }

  const sample = pages.map((p) => p.markdown).join("\n\n").slice(0, CLASSIFY_SAMPLE_CHARS);
  try {
    const raw = await generateJson<{ doc_kind: string; confidence: number; reason: string; language?: string | null; title?: string | null }>(
      GEMINI_FAST_MODEL,
      createUserContent([
        `Classify this document into exactly one doc_kind from the enum. Filename: ${filename}\n\n---\n${sample}`,
      ]),
      TEXT_CLASSIFY_SCHEMA
    );
    return {
      ...base,
      docKind: (DOC_KINDS.includes(raw.doc_kind as DocKind) ? raw.doc_kind : "generic_text") as DocKind,
      confidence: Math.min(1, Math.max(0, raw.confidence ?? 0)),
      reason: raw.reason || "",
      language: raw.language ?? null,
      title: raw.title || filename,
    };
  } catch (err) {
    console.warn(`[classify] text classification failed for ${filename}, defaulting:`, err);
    return { ...base, docKind: "generic_text", confidence: 0, reason: "Classifier unavailable; defaulted.", language: null, title: filename };
  }
}
