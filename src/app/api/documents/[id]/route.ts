import { NextResponse } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";
import { deleteObject } from "@/lib/storage";

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const user = await getAuthUser(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;

  const { data: doc, error } = await supabase
    .from("documents")
    .select("*")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (error || !doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  const { data: events } = await supabase
    .from("ingestion_events")
    .select("id, stage, status, detail, ms, created_at")
    .eq("document_id", id)
    .order("id", { ascending: true });

  return NextResponse.json({ data: { ...doc, events: events ?? [] } });
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const user = await getAuthUser(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;

  const { data: doc, error: fetchError } = await supabase
    .from("documents")
    .select("storage_key")
    .eq("id", id)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (fetchError || !doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

  // Chunks/messages/citations cascade via FK; the S3 object does not, so it
  // has to be cleaned up explicitly. If this throws, the DB row is left in
  // place rather than orphaning the row with no way to retry the object
  // delete -- delete the object first, the DB row second.
  try {
    await deleteObject(doc.storage_key);
  } catch (storageError) {
    console.error("Failed to delete object from storage:", storageError);
    return NextResponse.json({ error: "Failed to delete the stored file." }, { status: 500 });
  }

  const { error: deleteError } = await supabase
    .from("documents")
    .delete()
    .eq("id", id)
    .eq("owner_id", user.id);

  if (deleteError) {
    console.error("document delete error:", deleteError);
    return NextResponse.json({ error: "Failed to delete document record." }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
