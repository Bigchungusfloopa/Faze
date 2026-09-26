"use client"

import { useCallback, useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { MessageSquare, Plus, Trash2, UploadCloud, X } from "lucide-react"
import { ChatPanel } from "@/components/rag/ChatPanel"
import { DocumentPipelineCard } from "@/components/rag/DocumentPipelineCard"
import { WorkspaceSwitcher, type WorkspaceScope } from "@/components/rag/WorkspaceSwitcher"
import { useRagChat } from "@/hooks/useRagChat"
import { useUploadDocuments } from "@/hooks/useUploadDocuments"
import { useDragAndDrop } from "@/hooks/useDragAndDrop"
import { cn } from "@/lib/utils"
import type { DocumentRow } from "@/types/rag"

interface ConversationSummary {
  id: string
  title: string
  updated_at: string
}

const ACTIVE_STATUSES = new Set(["pending_upload", "queued", "processing"])

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return (await res.json()).data as T
}

export default function ResearchPage() {
  const [scope, setScope] = useState<WorkspaceScope>({ workspaceId: null, name: "Personal" })
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const chat = useRagChat()
  const { resetConversation, loadConversation, conversationId, isStreaming } = chat
  const scopeQs = scope.workspaceId ? `?workspaceId=${scope.workspaceId}` : ""

  const { data: documents = [], isLoading: docsLoading } = useQuery({
    // Scope is in every key so switching never flashes the previous scope's data.
    queryKey: ["documents", scope.workspaceId],
    queryFn: () => getJson<DocumentRow[]>(`/api/documents${scopeQs}`),
    refetchInterval: (query) => ((query.state.data ?? []).some((d) => ACTIVE_STATUSES.has(d.status)) ? 1500 : false),
  })

  const { data: conversations = [], refetch: refetchConversations } = useQuery({
    queryKey: ["conversations", scope.workspaceId],
    queryFn: () => getJson<ConversationSummary[]>(`/api/rag/conversations${scopeQs}`),
  })

  const upload = useUploadDocuments(scope.workspaceId ?? undefined)
  const onDrop = useCallback((files: File[]) => upload.mutate(files), [upload])
  const { isDragging } = useDragAndDrop(onDrop)

  // A thread is bound to the scope it started in; switching scope starts fresh.
  useEffect(() => {
    resetConversation()
  }, [scope.workspaceId, resetConversation])

  const openConversation = async (id: string) => {
    if (isStreaming || id === conversationId) return
    setSidebarOpen(false)
    try {
      await loadConversation(id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not load conversation.")
    }
  }

  const deleteConversation = async (id: string) => {
    const res = await fetch(`/api/rag/conversations/${id}`, { method: "DELETE" })
    if (!res.ok) return toast.error("Could not delete conversation.")
    if (id === conversationId) resetConversation()
    void refetchConversations()
  }

  const readyCount = documents.filter((d) => d.status === "ready").length

  return (
    <div className="flex h-full gap-3 p-3">
      {isDragging && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 backdrop-blur-xl">
          <div className="glass-card rounded-[28px] border-2 border-dashed border-white/25 px-16 py-12 text-center">
            <UploadCloud size={52} className="mx-auto text-white" />
            <h2 className="mt-4 text-xl font-semibold">Drop documents into {scope.name}</h2>
            <p className="mt-1.5 text-[13px] text-white/55">PDF, images, Word, PowerPoint, Excel, CSV, text</p>
          </div>
        </div>
      )}

      {sidebarOpen && <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setSidebarOpen(false)} />}

      <aside
        className={cn(
          "glass-card z-50 flex w-72 shrink-0 flex-col overflow-hidden rounded-[22px] shadow-[0_8px_32px_rgba(0,0,0,0.35)]",
          "fixed inset-y-3 left-3 transition-transform md:static md:translate-x-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-[110%]"
        )}
      >
        <div className="flex items-center gap-2 border-b border-white/[0.08] p-3">
          <div className="min-w-0 flex-1">
            <WorkspaceSwitcher scope={scope} onScopeChange={setScope} />
          </div>
          <button type="button" onClick={() => setSidebarOpen(false)} className="rounded-lg p-1.5 text-white/60 hover:bg-white/10 md:hidden" aria-label="Close sidebar">
            <X size={15} />
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            resetConversation()
            setSidebarOpen(false)
          }}
          disabled={isStreaming}
          className="glass-pill mx-3 mt-3 flex items-center justify-center gap-2 rounded-[14px] py-2.5 text-[13px] font-medium transition-colors hover:bg-white/[0.12] disabled:opacity-40"
        >
          <Plus size={14} /> New chat
        </button>

        <p className="px-4 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.08em] text-white/30">Recent</p>
        <div className="max-h-[32%] shrink-0 overflow-y-auto px-2">
          {conversations.length === 0 ? (
            <p className="px-2 py-2 text-xs text-white/40">No conversations yet</p>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={cn(
                  "group flex items-center gap-2 rounded-[10px] px-2.5 py-2 text-[13px] transition-colors",
                  c.id === conversationId ? "bg-white/[0.09] text-white" : "text-white/55 hover:bg-white/[0.06] hover:text-white"
                )}
              >
                <button type="button" onClick={() => openConversation(c.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <MessageSquare size={12} className="shrink-0 opacity-50" />
                  <span className="truncate">{c.title}</span>
                </button>
                <button
                  type="button"
                  onClick={() => deleteConversation(c.id)}
                  className="shrink-0 text-white/30 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
                  aria-label="Delete conversation"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-white/30">
            Documents{documents.length > 0 ? ` · ${documents.length}` : ""}
          </p>
          {upload.isPending && <span className="text-[10px] text-white/50">Uploading…</span>}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
          {docsLoading ? (
            <p className="px-1 text-xs text-white/40">Loading…</p>
          ) : documents.length === 0 ? (
            <p className="px-1 text-xs leading-relaxed text-white/40">
              Nothing here yet. Drop files anywhere on the page, or use the upload button next to the chat box.
              {scope.workspaceId && " Everything uploaded here is visible to every member of this workspace."}
            </p>
          ) : (
            documents.map((doc) => <DocumentPipelineCard key={doc.id} doc={doc} />)
          )}
        </div>
      </aside>

      <ChatPanel
        chat={chat}
        workspaceId={scope.workspaceId}
        scopeName={scope.workspaceId ? `${scope.name} workspace` : "Personal documents"}
        readyCount={readyCount}
        uploading={upload.isPending}
        onUpload={(files) => upload.mutate(files)}
        onOpenSidebar={() => setSidebarOpen(true)}
      />
    </div>
  )
}
