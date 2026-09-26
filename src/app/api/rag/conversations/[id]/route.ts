import { NextResponse } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";

type Params = { params: Promise<{ id: string }> };

interface CitationRow {
  marker: number;
  document_id: string | null;
  document_title: string | null;
  page_from: number | null;
  page_to: number | null;
  section_path: string[];
  snippet: string;
}

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  verdict: string | null;
  grounding: { uncitedRatio?: number; invalidCitations?: number[] } | null;
  sub_queries: string[] | null;
  message_citations: CitationRow[];
}

const SUFFICIENT = new Set(["answered", "partial", "conflicting_evidence"]);

/** A saved conversation, shaped like the live chat stream so the UI renders both identically. */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const user = await getAuthUser(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: conv } = await supabase
    .from("conversations")
    .select("id, title, workspace_id")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();
  if (!conv) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, verdict, grounding, sub_queries, message_citations(marker, document_id, document_title, page_from, page_to, section_path, snippet)")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const messages = (data as MessageRow[]).map((m) => ({
    id: m.id,
    role: m.role,
    text: m.content,
    streaming: false,
    stage: null,
    subQueries: m.sub_queries ?? undefined,
    sources: (m.message_citations ?? [])
      .slice()
      .sort((a, b) => a.marker - b.marker)
      .map((c) => ({
        marker: c.marker,
        documentId: c.document_id ?? "",
        documentTitle: c.document_title ?? "Deleted document",
        pageFrom: c.page_from,
        pageTo: c.page_to,
        sectionPath: c.section_path ?? [],
        snippet: c.snippet,
      })),
    grounding:
      m.role === "assistant" && m.verdict
        ? {
            sufficient: SUFFICIENT.has(m.verdict),
            verdict: m.verdict,
            uncitedRatio: m.grounding?.uncitedRatio,
            invalidCitations: m.grounding?.invalidCitations,
          }
        : null,
  }));

  return NextResponse.json({ data: { id: conv.id, title: conv.title, workspaceId: conv.workspace_id, messages } });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  const supabase = await createClient();
  const user = await getAuthUser(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabase.from("conversations").delete().eq("id", id).eq("owner_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
