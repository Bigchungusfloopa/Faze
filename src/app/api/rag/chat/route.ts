import { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { rewriteQuery, type HistoryTurn } from "@/lib/rag/rewrite";
import { retrieveMulti } from "@/lib/rag/retrieve";
import { rerank } from "@/lib/rag/rerank";
import { assembleEvidence, buildUserPrompt } from "@/lib/rag/prompt";
import { parseCitations, buildCitationRows } from "@/lib/rag/citations";
import { getGenAI } from "@/lib/gemini/client";
import { GEMINI_ANSWER_MODEL } from "@/lib/gemini/models";
import type { GenerateContentParameters } from "@google/genai";

export const runtime = "nodejs";
export const maxDuration = 120;

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The provider genuinely returns 503 "high demand" on individual models from
 * time to time (observed directly, not hypothesized) -- this failure mode
 * throws before any token is yielded, so retrying the call that OBTAINS the
 * stream is safe and doesn't risk duplicating already-streamed output. A
 * failure mid-stream, after tokens have reached the client, is not retried
 * here; restarting generation at that point would require the client to
 * discard partial output, which is a UX decision, not a transport one.
 */
async function generateStreamWithRetry(params: GenerateContentParameters, maxAttempts = 3) {
  const ai = getGenAI();
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.models.generateContentStream(params);
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const retryable = status === 503 || status === 429;
      if (!retryable || attempt >= maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/**
 * Grounded chat over the corpus, streamed as Server-Sent Events:
 *   stage -> sources -> token* -> grounding -> done
 *
 * Emitting `sources` before the first token is what makes citation feel
 * instant -- the evidence rail populates while the answer is still
 * streaming, so a [3] the model writes a moment later is already a live
 * link. Retrieval and reranking happen with the user's OWN cookie-scoped
 * client, never the admin client -- hybrid_search_chunks is SECURITY INVOKER
 * and depends on it.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  const body = await request.json().catch(() => null);
  const message = (body?.message as string | undefined)?.trim();
  const conversationId = body?.conversationId as string | undefined;
  const documentIds = (body?.documentIds as string[] | undefined) ?? null;
  const workspaceId = (body?.workspaceId as string | undefined) || null;

  if (!message) return new Response(JSON.stringify({ error: "message is required" }), { status: 400 });

  // Fail fast with a clear message rather than a silently-empty retrieval --
  // hybrid_search_chunks would just return nothing for a workspace the
  // caller isn't in (RLS), which looks identical to "the workspace has no
  // relevant documents" from the client's side.
  if (workspaceId) {
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) {
      return new Response(JSON.stringify({ error: "You are not a member of that workspace." }), { status: 403 });
    }
  }

  let convId = conversationId;
  if (convId) {
    // RLS limits this to the caller's own conversations; the scope check stops
    // a personal thread from continuing against a workspace corpus (or vice versa).
    const { data: existing } = await supabase
      .from("conversations")
      .select("workspace_id")
      .eq("id", convId)
      .maybeSingle();
    if (!existing) return new Response(JSON.stringify({ error: "Conversation not found" }), { status: 404 });
    if ((existing.workspace_id ?? null) !== workspaceId) {
      return new Response(JSON.stringify({ error: "Conversation belongs to a different scope." }), { status: 409 });
    }
    await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId);
  } else {
    const { data: conv, error } = await supabase
      .from("conversations")
      .insert({ owner_id: user.id, title: message.slice(0, 60), scope_document_ids: documentIds, workspace_id: workspaceId })
      .select("id")
      .single();
    if (error || !conv) {
      return new Response(JSON.stringify({ error: "Failed to create conversation" }), { status: 500 });
    }
    convId = conv.id;
  }

  const { data: historyRows } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", convId)
    .order("created_at", { ascending: true })
    .limit(12);
  const history: HistoryTurn[] = (historyRows ?? []) as HistoryTurn[];

  await supabase.from("messages").insert({ conversation_id: convId, owner_id: user.id, role: "user", content: message });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      const push = (event: string, data: unknown) => controller.enqueue(enc.encode(sse(event, data)));
      const finish = () => controller.close();

      try {
        await runTurn({ supabase, userId: user.id, conversationId: convId!, message, history, documentIds, workspaceId, push });
      } catch (err) {
        push("stage", { stage: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        finish();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}

type Push = (event: string, data: unknown) => void;

async function runTurn(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  conversationId: string;
  message: string;
  history: HistoryTurn[];
  documentIds: string[] | null;
  workspaceId: string | null;
  push: Push;
}) {
  const { supabase, userId, conversationId, message, history, documentIds, workspaceId, push } = args;

  push("stage", { stage: "rewriting", conversationId });
  const rewrite = await rewriteQuery(message, history);

  if (!rewrite.needsRetrieval) {
    await runChitchat(supabase, userId, conversationId, message, history, rewrite, push);
    return;
  }

  push("stage", { stage: "retrieving", subQueries: rewrite.subQueries });
  const retrievalStart = Date.now();
  const candidates = await retrieveMulti(supabase, rewrite.subQueries, documentIds, 40, workspaceId);
  const retrievalMs = Date.now() - retrievalStart;

  push("stage", { stage: "reranking" });
  const rerankStart = Date.now();
  const rr = await rerank(rewrite.standaloneQuery, candidates);
  const rerankMs = Date.now() - rerankStart;

  if (!rr.sufficient) {
    await runAbstention(supabase, userId, conversationId, rewrite, candidates.length, retrievalMs, rerankMs, rr.nearMisses, push);
    return;
  }

  await runGrounded(supabase, userId, conversationId, rewrite, candidates.length, retrievalMs, rerankMs, rr.evidence, push);
}

async function runChitchat(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  conversationId: string,
  message: string,
  history: HistoryTurn[],
  rewrite: Awaited<ReturnType<typeof rewriteQuery>>,
  push: Push
) {
  push("stage", { stage: "generating" });
  const historyText = history.map((h) => `${h.role}: ${h.content}`).join("\n");
  const genStream = await generateStreamWithRetry({
    model: GEMINI_ANSWER_MODEL,
    contents:
      `Conversation so far:\n${historyText}\n\nUser: ${message}\n\n` +
      `Reply naturally and briefly. You have no documents to cite for this message.`,
  });

  let full = "";
  for await (const chunk of genStream) {
    const delta = chunk.text ?? "";
    if (delta) {
      full += delta;
      push("token", { text: delta });
    }
  }

  const { data: asstMsg } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      owner_id: userId,
      role: "assistant",
      content: full,
      verdict: "no_retrieval",
      rewritten_query: rewrite.standaloneQuery,
      sub_queries: rewrite.subQueries,
      model: GEMINI_ANSWER_MODEL,
    })
    .select("id")
    .single();

  push("grounding", { sufficient: true, verdict: "no_retrieval" });
  push("done", { messageId: asstMsg?.id });
}

async function runAbstention(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  conversationId: string,
  rewrite: Awaited<ReturnType<typeof rewriteQuery>>,
  candidateCount: number,
  retrievalMs: number,
  rerankMs: number,
  nearMisses: Parameters<typeof assembleEvidence>[0],
  push: Push
) {
  // The generator is never called in this branch. A model cannot fabricate
  // an answer it was never asked to write -- this is the abstention gate
  // enforced in code, not left to a prompt instruction.
  const { evidence: nearEvidence } = assembleEvidence(nearMisses);
  const text = "I couldn't find anything in your documents that answers this.";

  push("sources", { sources: nearEvidence.map((e) => ({ ...e, snippet: e.snippet.slice(0, 200) })), nearMiss: true });
  push("token", { text });

  const { data: asstMsg } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      owner_id: userId,
      role: "assistant",
      content: text,
      verdict: "insufficient_evidence",
      rewritten_query: rewrite.standaloneQuery,
      sub_queries: rewrite.subQueries,
      retrieval_ms: retrievalMs,
      rerank_ms: rerankMs,
      retrieval: { candidateCount },
    })
    .select("id")
    .single();

  if (asstMsg && nearEvidence.length > 0) {
    const rows = nearEvidence.map((e) => ({
      message_id: asstMsg.id,
      owner_id: userId,
      chunk_id: e.chunkId,
      document_id: e.documentId,
      marker: e.marker,
      document_title: e.documentTitle,
      page_from: e.pageFrom,
      page_to: e.pageTo,
      section_path: e.sectionPath,
      snippet: e.snippet.slice(0, 300),
      rerank_score: e.rerankScore,
      used_in_answer: false,
    }));
    await supabase.from("message_citations").insert(rows);
  }

  push("grounding", {
    sufficient: false,
    verdict: "insufficient_evidence",
    missing: ["Nothing in your documents addresses this question."],
  });
  push("done", { messageId: asstMsg?.id });
}

const SAFE_TAIL = 20; // holds back this many trailing chars so "VERDICT:" is never split across a forwarded chunk boundary

async function runGrounded(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  conversationId: string,
  rewrite: Awaited<ReturnType<typeof rewriteQuery>>,
  candidateCount: number,
  retrievalMs: number,
  rerankMs: number,
  evidenceChunks: Parameters<typeof assembleEvidence>[0],
  push: Push
) {
  const { evidence, block } = assembleEvidence(evidenceChunks);
  push("sources", {
    sources: evidence.map((e) => ({
      marker: e.marker,
      documentId: e.documentId,
      documentTitle: e.documentTitle,
      pageFrom: e.pageFrom,
      pageTo: e.pageTo,
      sectionPath: e.sectionPath,
      snippet: e.snippet.slice(0, 200),
    })),
  });

  push("stage", { stage: "generating" });
  const prompt = buildUserPrompt(rewrite.standaloneQuery, block);
  const genStream = await generateStreamWithRetry({
    model: GEMINI_ANSWER_MODEL,
    contents: prompt,
    config: { temperature: 0.1 },
  });

  const generateStart = Date.now();
  let fullRaw = "";
  let pending = "";
  let verdictSeen = false;

  for await (const chunk of genStream) {
    const delta = chunk.text ?? "";
    if (!delta) continue;
    fullRaw += delta;
    if (verdictSeen) continue; // keep draining the stream, but the trailing VERDICT line is metadata, never shown

    pending += delta;
    const idx = pending.indexOf("VERDICT:");
    if (idx !== -1) {
      const visible = pending.slice(0, idx).replace(/\n+$/, "");
      if (visible) push("token", { text: visible });
      verdictSeen = true;
      pending = "";
      continue;
    }
    if (pending.length > SAFE_TAIL) {
      const forward = pending.slice(0, pending.length - SAFE_TAIL);
      pending = pending.slice(pending.length - SAFE_TAIL);
      if (forward) push("token", { text: forward });
    }
  }
  if (!verdictSeen && pending) push("token", { text: pending });

  const generateMs = Date.now() - generateStart;
  const verdictIdx = fullRaw.indexOf("VERDICT:");
  const visibleText = (verdictIdx !== -1 ? fullRaw.slice(0, verdictIdx) : fullRaw).replace(/\n+$/, "");
  const verdictMatch = fullRaw.match(/VERDICT:\s*(answered|partial|conflicting_evidence)/i);
  let finalVerdict = (verdictMatch ? verdictMatch[1].toLowerCase() : "answered") as
    | "answered"
    | "partial"
    | "conflicting_evidence";

  const validMarkers = new Set(evidence.map((e) => e.marker));
  const parsed = parseCitations(visibleText, validMarkers);
  if (parsed.uncitedRatio > 0.3 && finalVerdict === "answered") finalVerdict = "partial";

  const { data: asstMsg } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      owner_id: userId,
      role: "assistant",
      content: parsed.cleanedText,
      verdict: finalVerdict,
      rewritten_query: rewrite.standaloneQuery,
      sub_queries: rewrite.subQueries,
      retrieval_ms: retrievalMs,
      rerank_ms: rerankMs,
      generate_ms: generateMs,
      model: GEMINI_ANSWER_MODEL,
      retrieval: { candidateCount, evidenceCount: evidence.length },
      grounding: { uncitedRatio: parsed.uncitedRatio, invalidCitations: parsed.invalidMarkers },
    })
    .select("id")
    .single();

  if (asstMsg) {
    const rows = buildCitationRows(parsed.cleanedText, parsed, evidence).map((r) => ({
      ...r,
      message_id: asstMsg.id,
      owner_id: userId,
    }));
    if (rows.length > 0) await supabase.from("message_citations").insert(rows);
  }

  push("grounding", {
    sufficient: true,
    verdict: finalVerdict,
    invalidCitations: parsed.invalidMarkers,
    uncitedRatio: parsed.uncitedRatio,
  });
  push("done", { messageId: asstMsg?.id });
}
