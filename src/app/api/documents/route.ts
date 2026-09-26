import { NextResponse, after } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";
import { runIngestion } from "@/lib/rag/ingest/pipeline";

export const maxDuration = 300;

/**
 * Step 2 of the upload flow: the client calls this once the presigned PUT to
 * the bucket has actually succeeded. Flips pending_upload -> queued and kicks
 * ingestion via after(), which runs once the response has been sent so the
 * client isn't left waiting on however long ingestion takes.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const user = await getAuthUser(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const documentId = body?.documentId as string | undefined;
  if (!documentId) {
    return NextResponse.json({ error: "documentId is required." }, { status: 400 });
  }

  const { data: doc, error: updateError } = await supabase
    .from("documents")
    .update({ status: "queued" })
    .eq("id", documentId)
    .eq("owner_id", user.id)
    .eq("status", "pending_upload")
    .select("id, status")
    .maybeSingle();

  if (updateError) {
    console.error("confirm upload error:", updateError);
    return NextResponse.json({ error: "Failed to confirm upload." }, { status: 500 });
  }
  if (!doc) {
    // Either it doesn't belong to this user, doesn't exist, or was already
    // confirmed -- in the last case this is a harmless re-click, not an error.
    const { data: existing } = await supabase
      .from("documents")
      .select("id, status")
      .eq("id", documentId)
      .eq("owner_id", user.id)
      .maybeSingle();
    if (existing) return NextResponse.json({ documentId: existing.id, status: existing.status });
    return NextResponse.json({ error: "Document not found." }, { status: 404 });
  }

  after(() => runIngestion(documentId));

  return NextResponse.json({ documentId: doc.id, status: doc.status });
}

/**
 * List documents in one scope: the caller's personal corpus (default), or a
 * workspace's shared corpus when ?workspaceId= is given -- these are two
 * disjoint sets by design, never mixed in one response. ?status=active
 * restricts to rows still moving through the pipeline
 * (pending_upload/queued/processing), which the pipeline-status poller in
 * the UI runs every ~1.5s so it can stop once nothing is left in flight.
 */
export async function GET(request: Request) {
  const supabase = await createClient();
  const user = await getAuthUser(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const statusFilter = searchParams.get("status");
  const workspaceId = searchParams.get("workspaceId");

  let query = supabase
    .from("documents")
    .select(
      "id, title, source_filename, mime_type, size_bytes, status, stage, progress_pct, " +
        "stage_detail, error, doc_kind, pipeline, page_count, chunk_count, workspace_id, " +
        "owner_id, created_at, updated_at"
    )
    .order("created_at", { ascending: false });

  // RLS (documents_select) restricts a workspace-scoped query to actual
  // members regardless of this filter -- it's applied for a correct empty
  // result rather than an opaque permission error when it's omitted.
  query = workspaceId ? query.eq("workspace_id", workspaceId) : query.eq("owner_id", user.id).is("workspace_id", null);

  if (statusFilter === "active") {
    query = query.in("status", ["pending_upload", "queued", "processing"]);
  }

  const { data, error } = await query;
  if (error) {
    console.error("documents list error:", error);
    return NextResponse.json({ error: "Failed to list documents." }, { status: 500 });
  }

  return NextResponse.json({ data });
}
