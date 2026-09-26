"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { FileText, User } from "lucide-react"
import type { ChatMessage } from "@/hooks/useRagChat"
import { VerdictBadge } from "./VerdictBadge"

// [n] markers become in-page links so they survive markdown parsing intact;
// the `a` renderer below turns exactly those links back into citation pills.
const CITE_PREFIX = "#cite-"
function linkifyMarkers(text: string) {
  return text.replace(/\[(\d+)\]/g, (_, n) => `[${n}](${CITE_PREFIX}${n})`)
}

const STAGE_LABELS: Record<string, string> = {
  starting: "Starting…",
  rewriting: "Thinking about your question…",
  retrieving: "Searching your documents…",
  reranking: "Weighing the evidence…",
  generating: "Writing an answer…",
}

function Avatar({ assistant }: { assistant: boolean }) {
  return (
    <div
      className={
        assistant
          ? "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white text-black"
          : "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/15 bg-white/10 text-white"
      }
    >
      {assistant ? <FileText size={13} /> : <User size={13} />}
    </div>
  )
}

function ThinkingDots() {
  return (
    <span className="flex items-center gap-1.5 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 rounded-full bg-white/50"
          style={{ animation: `thinking-bounce 1.4s ease-in-out ${i * 0.16}s infinite` }}
        />
      ))}
    </span>
  )
}

export function MessageBubble({
  message,
  onCitationClick,
}: {
  message: ChatMessage
  onCitationClick: (marker: number) => void
}) {
  if (message.role === "user") {
    return (
      <div className="flex flex-row-reverse gap-2.5">
        <Avatar assistant={false} />
        <div className="max-w-[75%] whitespace-pre-wrap rounded-[18px_18px_4px_18px] bg-white px-4 py-2.5 text-sm font-medium leading-relaxed text-neutral-900 shadow-[0_2px_16px_rgba(0,0,0,0.25)]">
          {message.text}
        </div>
      </div>
    )
  }

  const waiting = message.streaming && !message.text

  return (
    <div className="flex gap-2.5">
      <Avatar assistant />
      <div className="glass-card flex max-w-[80%] flex-col gap-2 rounded-[18px_18px_18px_4px] px-4 py-3 text-sm leading-relaxed text-white/90">
        {waiting && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-xs text-white/60">
              <ThinkingDots />
              {message.stage && (STAGE_LABELS[message.stage] ?? message.stage)}
            </div>
            {message.subQueries && message.subQueries.length > 1 && (
              <ul className="text-xs text-white/45">
                {message.subQueries.map((q, i) => (
                  <li key={i}>· {q}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {message.text && (
          <div className="prose-faze">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => {
                  if (href?.startsWith(CITE_PREFIX)) {
                    const marker = Number(href.slice(CITE_PREFIX.length))
                    return (
                      <button
                        type="button"
                        onClick={() => onCitationClick(marker)}
                        className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-white px-1 align-middle text-[10px] font-bold text-black hover:opacity-80"
                      >
                        {marker}
                      </button>
                    )
                  }
                  return (
                    <a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                      {children}
                    </a>
                  )
                },
              }}
            >
              {linkifyMarkers(message.text)}
            </ReactMarkdown>
          </div>
        )}

        {message.grounding && <VerdictBadge grounding={message.grounding} />}
        {message.grounding?.missing && message.grounding.missing.length > 0 && (
          <p className="text-xs text-white/55">{message.grounding.missing.join(" ")}</p>
        )}
      </div>
    </div>
  )
}
