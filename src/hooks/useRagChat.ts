import { useCallback, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

export interface ChatSource {
  marker: number
  documentId: string
  documentTitle: string
  pageFrom: number | null
  pageTo: number | null
  sectionPath: string[]
  snippet: string
}

export interface ChatGrounding {
  sufficient: boolean
  verdict: "answered" | "partial" | "insufficient_evidence" | "conflicting_evidence" | "no_retrieval"
  invalidCitations?: number[]
  uncitedRatio?: number
  missing?: string[]
}

export interface ChatMessage {
  id: string
  role: "user" | "assistant"
  text: string
  sources: ChatSource[]
  grounding: ChatGrounding | null
  streaming: boolean
  stage: string | null
  subQueries?: string[]
}

/**
 * Manual SSE consumption, not the native EventSource: our endpoint is POST
 * with a JSON body, and EventSource only ever issues GET. Parses
 * "event:\ndata:\n\n" blocks off the raw byte stream by hand.
 */
export function useRagChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const conversationIdRef = useRef<string | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const send = useCallback(async (text: string, documentIds?: string[], workspaceId?: string | null) => {
    const userMsg: ChatMessage = { id: `u-${Date.now()}`, role: "user", text, sources: [], grounding: null, streaming: false, stage: null }
    const asstMsg: ChatMessage = { id: `a-${Date.now()}`, role: "assistant", text: "", sources: [], grounding: null, streaming: true, stage: "starting" }
    setMessages((prev) => [...prev, userMsg, asstMsg])
    setIsStreaming(true)

    const patchLast = (patch: Partial<ChatMessage>) =>
      setMessages((prev) => {
        const next = [...prev]
        const last = next[next.length - 1]
        next[next.length - 1] = { ...last, ...patch }
        return next
      })

    try {
      const res = await fetch("/api/rag/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          conversationId: conversationIdRef.current,
          documentIds: documentIds && documentIds.length > 0 ? documentIds : undefined,
          workspaceId: workspaceId ?? undefined,
        }),
      })
      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => null)
        throw new Error(detail?.error || `Chat request failed (${res.status})`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let accumulatedText = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let sepIndex: number
        while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, sepIndex)
          buffer = buffer.slice(sepIndex + 2)

          const eventLine = block.split("\n").find((l) => l.startsWith("event: "))
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "))
          if (!eventLine || !dataLine) continue
          const event = eventLine.slice("event: ".length)
          const data = JSON.parse(dataLine.slice("data: ".length))

          if (event === "stage") {
            if (data.conversationId && data.conversationId !== conversationIdRef.current) {
              conversationIdRef.current = data.conversationId
              setConversationId(data.conversationId)
            }
            patchLast({ stage: data.stage, subQueries: data.subQueries })
          } else if (event === "sources") {
            patchLast({ sources: data.sources })
          } else if (event === "token") {
            accumulatedText += data.text
            patchLast({ text: accumulatedText, stage: null })
          } else if (event === "grounding") {
            patchLast({ grounding: data })
          } else if (event === "done") {
            patchLast({ streaming: false, id: data.messageId ?? asstMsg.id })
          }
        }
      }
    } catch (err) {
      patchLast({
        streaming: false,
        stage: null,
        text: `Something went wrong: ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      setIsStreaming(false)
      queryClient.invalidateQueries({ queryKey: ["conversations"] })
    }
  }, [queryClient])

  // Conversations aren't scoped to a workspace in this pass -- switching
  // scope mid-session must start a fresh conversation rather than silently
  // mixing personal and workspace history into one thread's context.
  const resetConversation = useCallback(() => {
    conversationIdRef.current = null
    setConversationId(null)
    setMessages([])
  }, [])

  const loadConversation = useCallback(async (id: string) => {
    const res = await fetch(`/api/rag/conversations/${id}`)
    if (!res.ok) throw new Error("Could not load that conversation.")
    const { data } = await res.json()
    conversationIdRef.current = id
    setConversationId(id)
    setMessages(data.messages as ChatMessage[])
  }, [])

  return { messages, isStreaming, send, resetConversation, loadConversation, conversationId }
}
