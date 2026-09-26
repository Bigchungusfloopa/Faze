"use client"

import { FileText } from "lucide-react"
import type { ChatSource } from "@/hooks/useRagChat"

export function CitationRail({
  sources,
  activeMarker,
  nearMiss,
}: {
  sources: ChatSource[]
  activeMarker: number | null
  nearMiss?: boolean
}) {
  if (sources.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wide">
        {nearMiss ? "Closest matches (not used)" : "Sources"}
      </p>
      {sources.map((s) => (
        <div
          key={s.marker}
          id={`source-${s.marker}`}
          className={`rounded-xl border p-2.5 text-xs transition-colors ${
            activeMarker === s.marker ? "border-white/40 bg-white/10" : "border-white/10 bg-white/[0.04]"
          }`}
        >
          <div className="flex items-start gap-1.5">
            <span className="shrink-0 font-bold bg-foreground text-background rounded-full w-4 h-4 flex items-center justify-center text-[10px]">
              {s.marker}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1 font-bold truncate">
                <FileText className="w-3 h-3 shrink-0" />
                <span className="truncate">{s.documentTitle}</span>
              </div>
              <p className="text-muted-foreground mt-0.5">
                {s.pageFrom == null ? "" : s.pageFrom === s.pageTo ? `p. ${s.pageFrom}` : `pp. ${s.pageFrom}–${s.pageTo}`}
                {s.sectionPath.length > 0 ? ` · ${s.sectionPath.join(" > ")}` : ""}
              </p>
              <p className="mt-1 italic text-foreground/80 line-clamp-3">&ldquo;{s.snippet}&rdquo;</p>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
