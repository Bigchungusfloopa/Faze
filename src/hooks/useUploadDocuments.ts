import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { STORAGE_BUCKET } from "@/lib/storage-constants"
import { ACCEPTED_EXTENSIONS } from "@/lib/rag/ingest/formats"

export const UPLOAD_ACCEPT = ACCEPTED_EXTENSIONS.join(",")

async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const digest = await crypto.subtle.digest("SHA-256", buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

async function uploadOne(file: File, workspaceId?: string) {
  const checksumSha256 = await sha256Hex(file)

  const prepRes = await fetch("/api/documents/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      checksumSha256,
      workspaceId,
    }),
  })
  if (!prepRes.ok) {
    throw new Error((await prepRes.json().catch(() => ({}))).error || `Could not start upload for ${file.name}`)
  }
  const { documentId, duplicate, path, token } = await prepRes.json()

  if (duplicate) return { documentId, duplicate: true }

  // Supabase's signed-upload-URL flow is consumed through the SDK, not a raw
  // fetch PUT to the signed URL -- the wire format (multipart/FormData
  // wrapping, x-upsert header) is handled by uploadToSignedUrl itself.
  const supabase = createClient()
  const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).uploadToSignedUrl(path, token, file)
  if (uploadError) throw new Error(`Upload to storage failed for ${file.name}: ${uploadError.message}`)

  const confirmRes = await fetch("/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentId }),
  })
  if (!confirmRes.ok) {
    throw new Error((await confirmRes.json().catch(() => ({}))).error || `Could not confirm upload for ${file.name}`)
  }

  return { documentId, duplicate: false }
}

export function useUploadDocuments(workspaceId?: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (files: File[]) => {
      const results = await Promise.allSettled(files.map((f) => uploadOne(f, workspaceId)))
      return { results }
    },
    onSuccess: ({ results }) => {
      const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[]
      const duplicates = results.filter((r) => r.status === "fulfilled" && r.value.duplicate).length
      const succeeded = results.length - failures.length - duplicates

      if (succeeded > 0) toast.success(`${succeeded} document${succeeded === 1 ? "" : "s"} queued for ingestion.`)
      if (duplicates > 0) toast.info(`${duplicates} file${duplicates === 1 ? "" : "s"} already in this corpus.`)
      failures.forEach((f) => toast.error(f.reason?.message || "Upload failed."))

      queryClient.invalidateQueries({ queryKey: ["documents"] })
    },
    onError: (err: Error) => toast.error(err.message || "Upload failed."),
  })
}
