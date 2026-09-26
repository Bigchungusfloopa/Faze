import { NextResponse } from "next/server";
import { createClient, getAuthUser } from "@/lib/supabase/server";
import { getUploadToken } from "@/lib/storage";
import { STORAGE_BUCKET } from "@/lib/storage-constants";
import { resolveFormat } from "@/lib/rag/ingest/formats";

const MAX_FILE_SIZE = 45 * 1024 * 1024; // 45 MB — under Gemini's native 50MB PDF cap

/**
 * Step 1 of a direct-to-bucket upload: the client asks for a signed upload
 * token before it has sent any bytes. This sidesteps the ~4.5MB serverless
 * request-body ceiling that the vault's multipart upload route only survives
 * by luck at its 20MB cap.
 */
export async function POST(request: Request) {
  const supabase = await createClient();
  const user = await getAuthUser(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const filename = (body?.filename as string | undefined)?.trim();
  const rawMime = body?.mimeType as string | undefined;
  const sizeBytes = Number(body?.sizeBytes);
  const checksumSha256 = body?.checksumSha256 as string | undefined;
  const workspaceId = (body?.workspaceId as string | undefined) || null;

  if (!filename || !checksumSha256 || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return NextResponse.json(
      { error: "filename, mimeType, sizeBytes and checksumSha256 are required." },
      { status: 400 }
    );
  }
  const resolved = resolveFormat(filename, rawMime);
  if (!resolved) {
    return NextResponse.json(
      { error: `Unsupported file type for ${filename}. Supported: PDF, images, DOCX, PPTX, XLSX, CSV/TSV, TXT/MD/JSON.` },
      { status: 400 }
    );
  }
  const mimeType = resolved.mime;
  if (sizeBytes > MAX_FILE_SIZE) {
    return NextResponse.json({ error: "File exceeds the 45MB limit." }, { status: 400 });
  }

  // Fail fast with a clear message if the caller isn't actually a member --
  // RLS's documents_insert policy enforces this too, but that error is an
  // opaque 42501 from Postgres, not "you're not in this workspace."
  if (workspaceId) {
    const { data: membership } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (!membership) {
      return NextResponse.json({ error: "You are not a member of that workspace." }, { status: 403 });
    }
  }

  // Dedupe fast path -- enforced for real by the partial unique indexes from
  // 0007_document_dedupe_scope.sql, this lookup just avoids minting an
  // unused signed upload token. Scoped identically to those indexes: personal
  // dedupe keys on (owner, checksum) among workspace_id IS NULL rows;
  // workspace dedupe keys on (workspace, checksum) regardless of uploader.
  const dedupeQuery = supabase.from("documents").select("id, status").eq("checksum_sha256", checksumSha256);
  const { data: existing } = workspaceId
    ? await dedupeQuery.eq("workspace_id", workspaceId).maybeSingle()
    : await dedupeQuery.eq("owner_id", user.id).is("workspace_id", null).maybeSingle();

  if (existing) {
    return NextResponse.json({ documentId: existing.id, duplicate: true, path: null, token: null });
  }

  const ext = filename.split(".").pop() || "bin";
  const storageKey = workspaceId
    ? `workspaces/${workspaceId}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
    : `${user.id}/documents/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { data: doc, error: insertError } = await supabase
    .from("documents")
    .insert({
      owner_id: user.id,
      workspace_id: workspaceId,
      title: filename,
      source_filename: filename,
      mime_type: mimeType,
      size_bytes: sizeBytes,
      storage_key: storageKey,
      checksum_sha256: checksumSha256,
      status: "pending_upload" as const,
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("documents insert error:", insertError);
    return NextResponse.json({ error: "Failed to register document." }, { status: 500 });
  }

  const { path, token } = await getUploadToken(storageKey);
  return NextResponse.json({ documentId: doc.id, duplicate: false, bucket: STORAGE_BUCKET, path, token });
}
