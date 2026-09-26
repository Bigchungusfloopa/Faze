"use client"

import { useEffect, useRef, useState } from "react"
import { FileText, Menu, Send, UploadCloud } from "lucide-react"
import type { useRagChat } from "@/hooks/useRagChat"
import { UPLOAD_ACCEPT } from "@/hooks/useUploadDocuments"
import { MessageBubble } from "./MessageBubble"
import { CitationRail } from "./CitationRail"

type Chat = ReturnType<typeof useRagChat>

export function ChatPanel({
  chat,
  workspaceId,
  scopeName,
  readyCount,
  uploading,
  onUpload,
  onOpenSidebar,
}: {
  chat: Chat
  workspaceId: string | null
  scopeName: string
  readyCount: number
  uploading: boolean
  onUpload: (files: File[]) => void
  onOpenSidebar: () => void
}) {
  const { messages, isStreaming, send } = chat
  const [input, setInput] = useState("")
  const [activeMarker, setActiveMarker] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")
  const showRail = !!lastAssistant && lastAssistant.sources.length > 0

  const handleSend = () => {
    const text = input.trim()
    if (!text || isStreaming) return
    setInput("")
    if (textareaRef.current) textareaRef.current.style.height = "auto"
    void send(text, undefined, workspaceId)
  }

  const handleCitationClick = (marker: number) => {
    setActiveMarker(marker)
    document.getElementById(`source-${marker}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
  }

  return (
    <section className="glass-card relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[22px] shadow-[0_8px_40px_rgba(0,0,0,0.35)]">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-white/[0.08] bg-black/20 px-4 py-3 sm:px-5">
        <button type="button" onClick={onOpenSidebar} className="rounded-lg p-1.5 text-white/70 hover:bg-white/10 md:hidden" aria-label="Open sidebar">
          <Menu size={16} />
        </button>
        <div className="grid h-7 w-7 place-items-center rounded-full bg-white text-black">
          <FileText size={13} />
        </div>
        <div className="min-w-0">
          <p className="font-heading text-[15px] leading-tight tracking-tight">Faze</p>
          <p className="truncate text-[11px] text-white/45">{scopeName}</p>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-[11px] text-white/55">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${readyCount > 0 ? "bg-green-400" : "bg-amber-400"}`}
            style={{ animation: "pulse-status 2s ease-in-out infinite" }}
          />
          <span className="hidden sm:inline">
            {readyCount > 0 ? `Grounded on ${readyCount} document${readyCount === 1 ? "" : "s"}` : "No indexed documents yet"}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 py-6 sm:px-7">
            {messages.length === 0 ? (
              <div className="m-auto max-w-md text-center">
                <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-white text-black shadow-[0_0_32px_rgba(255,255,255,0.18)]">
                  <FileText size={20} />
                </div>
                <h2 className="font-heading text-xl tracking-tight">Ask your documents</h2>
                <p className="mt-2 text-sm text-white/55">
                  Answers come only from what&apos;s uploaded to <span className="text-white/80">{scopeName}</span>, with
                  page-level citations. If your documents don&apos;t cover something, Faze says so instead of guessing.
                </p>
              </div>
            ) : (
              messages.map((m) => <MessageBubble key={m.id} message={m} onCitationClick={handleCitationClick} />)
            )}
            <div ref={bottomRef} />
          </div>

          <div className="shrink-0 px-3 pb-4 pt-2 sm:px-5">
            <div className="glass-input mx-auto flex max-w-[820px] items-end gap-2 rounded-[20px] p-2 shadow-[0_4px_24px_rgba(0,0,0,0.25)]">
              <button
                type="button"
                title="Upload documents"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
                className="shrink-0 rounded-[10px] p-2.5 text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white disabled:opacity-40"
              >
                <UploadCloud size={18} className={uploading ? "animate-pulse" : ""} />
              </button>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                accept={UPLOAD_ACCEPT}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  if (files.length > 0) onUpload(files)
                  e.target.value = ""
                }}
              />
              <textarea
                ref={textareaRef}
                value={input}
                rows={1}
                disabled={isStreaming}
                placeholder="Ask anything about your documents… or drop files anywhere"
                onChange={(e) => {
                  setInput(e.target.value)
                  e.target.style.height = "auto"
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    handleSend()
                  }
                }}
                className="max-h-40 min-h-11 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm leading-relaxed text-white outline-none placeholder:text-white/30"
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={isStreaming || !input.trim()}
                className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-white text-neutral-900 shadow-[0_2px_10px_rgba(255,255,255,0.15)] transition-transform hover:scale-105 disabled:opacity-25 disabled:hover:scale-100"
                aria-label="Send"
              >
                <Send size={16} />
              </button>
            </div>
            <p className="mt-2.5 text-center text-[11px] text-white/25">
              Answers are drawn only from your documents. Check the cited sources for anything important.
            </p>
          </div>
        </div>

        {showRail && (
          <aside className="hidden w-72 shrink-0 overflow-y-auto border-l border-white/[0.08] p-3 lg:block">
            <CitationRail
              sources={lastAssistant.sources}
              activeMarker={activeMarker}
              nearMiss={lastAssistant.grounding?.verdict === "insufficient_evidence"}
            />
          </aside>
        )}
      </div>
    </section>
  )
}
