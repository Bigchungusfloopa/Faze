import { NextResponse, after } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";
import { runIngestion } from "@/lib/rag/ingest/pipeline";

export const maxDuration = 300;

/**
 * Manual retry. Works from any state the caller owns -- not just 'failed' --
 * by resetting the row back to 'queued' before re-invoking the pipeline, so
 * it also serves as a deliberate "reindex this" action from 'ready'.
 */
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const user = await getAuthUser(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;

  const { data: doc, error: updateError } = await supabase
    .from("documents")
    .update({
      status: "queued",
      stage: "uploaded",
      progress_pct: 0,
      error: null,
      attempts: 0,
      chunk_count: 0,
    })
    .eq("id", id)
    .eq("owner_id", user.id)
    .select("id")
    .maybeSingle();

  if (updateError) {
    console.error("reprocess error:", updateError);
    return NextResponse.json({ error: "Failed to reset document for reprocessing." }, { status: 500 });
  }
  if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  // Clear out any chunks from a prior run so a reprocess doesn't leave stale
  // rows sitting alongside the new ones.
  await supabase.from("chunks").delete().eq("document_id", id);

  after(() => runIngestion(id));

  return NextResponse.json({ documentId: id, status: "queued" });
}
