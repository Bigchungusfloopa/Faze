import React, { useState, useRef, useEffect } from 'react';
import {
  UploadCloud, ArrowLeft, Send,
  FileText, X, Paperclip, Plus, User,
  AlertTriangle, RefreshCw, Sparkles, Layers,
} from 'lucide-react';
import { Link } from 'react-router-dom';

const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4';

type Citation = {
  filename: string;
  page?: number | null;
  chunk_type?: string;
  snippet?: string;
};

type EvidenceItem = {
  file?: string;
  sheet?: string;
  columns?: string[];
  operation?: string;
  rows_analyzed?: number;
  result?: any;
  [key: string]: any;
};

type Message = {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  evidence?: EvidenceItem[];
  conflicting?: boolean;
  status?: string;
  originalQuestion?: string;
};

type IngestedDoc = {
  filename: string;
  pipeline: string;
  chunk_count: number;
  status: string;
};

type BackendStatus = {
  status: string;
  engine: string;
  is_real_gemini: boolean;
  model: string;
  ingested_count: number;
  files: IngestedDoc[];
};

/* ── Glass style helpers ── */
const frost = (alpha = 0.08, blur = 24) => ({
  background: `rgba(255,255,255,${alpha})`,
  border: '1px solid rgba(255,255,255,0.14)',
  backdropFilter: `blur(${blur}px) saturate(180%)`,
  WebkitBackdropFilter: `blur(${blur}px) saturate(180%)`,
} as React.CSSProperties);

export default function ChatPage() {
  const [sessionId] = useState<string>(() => 'sess_' + Math.random().toString(36).substring(2, 9));
  const [isDragging, setIsDragging] = useState(false);
  const [chatHistory, setChatHistory] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content:
        'Hello! I am your Document Intelligence Assistant. Upload any document — PDF, Excel, Word, PowerPoint, OCR Scan, or Image — and ask me anything with 100% grounded evidence and source citations.',
    },
  ]);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [resolvingIdx, setResolvingIdx] = useState<number | null>(null);
  const [backendStatus, setBackendStatus] = useState<BackendStatus | null>(null);
  const [ingestedDocs, setIngestedDocs] = useState<IngestedDoc[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Poll/fetch backend health and status
  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data: BackendStatus = await res.json();
        setBackendStatus(data);
        if (data.files) {
          setIngestedDocs(data.files);
        }
      }
    } catch (err) {
      console.warn('Backend not yet reachable:', err);
    }
  };

  useEffect(() => {
    fetchStatus();
    const timer = setInterval(fetchStatus, 6000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isThinking]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); setIsDragging(false); };
  
  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files.length > 0) {
      const droppedFiles = Array.from(e.dataTransfer.files);
      await processAndUploadFiles(droppedFiles);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      const selected = Array.from(e.target.files);
      await processAndUploadFiles(selected);
    }
  };

  const processAndUploadFiles = async (newFiles: File[]) => {
    setIsUploading(true);
    setFiles(prev => [...prev, ...newFiles]);

    for (const file of newFiles) {
      const formData = new FormData();
      formData.append('file', file);

      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (res.ok) {
          const data = await res.json();
          if (data.status === 'ok') {
            setIngestedDocs(prev => {
              const filtered = prev.filter(d => d.filename !== data.filename);
              return [...filtered, {
                filename: data.filename,
                pipeline: data.pipeline,
                chunk_count: data.chunk_count,
                status: data.status,
              }];
            });

            setMessages(prev => [
              ...prev,
              {
                role: 'assistant',
                content: `✓ Ingested **\`${data.filename}\`** through **\`${data.pipeline.toUpperCase()}\`** pipeline (${data.chunk_count} indexed chunks). Ready for questions!`,
              },
            ]);
          } else {
            setMessages(prev => [
              ...prev,
              {
                role: 'assistant',
                content: `⚠️ Could not index **\`${data.filename || file.name}\`**: ${data.reason || 'Document produced no extractable content.'}`,
              },
            ]);
          }
        } else {
          const errText = await res.text();
          setMessages(prev => [
            ...prev,
            {
              role: 'assistant',
              content: `⚠️ Failed to ingest **\`${file.name}\`**: ${errText}`,
            },
          ]);
        }
      } catch (err: any) {
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content: `⚠️ Ingestion network error for **\`${file.name}\`**: ${err.message || 'Check backend connection'}`,
          },
        ]);
      }
    }

    setIsUploading(false);
    await fetchStatus();
  };

  const handleDeleteDoc = async (filename: string) => {
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(filename)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setIngestedDocs(prev => prev.filter(d => d.filename !== filename));
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content: `Document **\`${filename}\`** has been removed from the active index.`,
          },
        ]);
        await fetchStatus();
      }
    } catch (err: any) {
      console.error('Failed to delete document', err);
    }
  };

  const removeFile = (i: number) => setFiles(prev => prev.filter((_, idx) => idx !== i));

  const handleSend = async () => {
    const text = input.trim();
    if (!text && files.length === 0) return;

    const userContent = text || 'Please summarize the uploaded documents.';
    const next: Message[] = [...messages, { role: 'user', content: userContent }];
    setMessages(next);
    setInput('');
    setFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setIsThinking(true);

    if (messages.length <= 2) {
      setChatHistory(prev => [userContent.slice(0, 30) + '...', ...prev]);
    }

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: userContent,
          session_id: sessionId,
        }),
      });

      if (!res.ok) {
        const err = await res.text();
        setIsThinking(false);
        setMessages(prev => [
          ...prev,
          {
            role: 'assistant',
            content: `Error from Intelligence Engine: ${err}`,
          },
        ]);
        return;
      }

      const data = await res.json();
      setIsThinking(false);

      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: data.answer || "I don't have enough information in the uploaded documents to answer that question.",
          citations: data.citations || [],
          evidence: data.evidence || [],
          conflicting: Boolean(data.conflicting),
          status: data.status,
          originalQuestion: userContent,
        },
      ]);
    } catch (e: any) {
      setIsThinking(false);
      setMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          content: `Connection error: Could not reach the backend server at \`/api/query\`. (${e.message})`,
        },
      ]);
    }
  };

  const handleResolveConflict = async (msgIdx: number, question: string, answerContext: string) => {
    setResolvingIdx(msgIdx);
    try {
      const res = await fetch('/api/resolve-conflict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question,
          session_id: sessionId,
          answer_context: answerContext,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setMessages(prev => {
          const updated = [...prev];
          updated[msgIdx] = {
            ...updated[msgIdx],
            content: `${updated[msgIdx].content}\n\n---\n### ⚖️ Optimal Conflict Resolution (LLM Search)\n${data.resolution || data.answer}`,
            conflicting: false,
          };
          return updated;
        });
      }
    } catch (err: any) {
      alert(`Conflict resolution error: ${err.message}`);
    } finally {
      setResolvingIdx(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const startNewChat = async () => {
    try {
      await fetch('/api/reset', { method: 'POST' });
    } catch (err) {
      console.warn('Reset error:', err);
    }
    setMessages([{ role: 'assistant', content: 'New chat session started! Upload a document or ask me anything.' }]);
    setFiles([]);
    setInput('');
    fetchStatus();
  };

  // Helper to format basic markdown (bold, headers, bullets, inline code)
  const renderFormatted = (text: string) => {
    const lines = text.split('\n');
    return lines.map((line, idx) => {
      if (line.startsWith('### ')) {
        return <h4 key={idx} style={{ fontSize: 15, fontWeight: 700, margin: '10px 0 4px', color: '#fff' }}>{line.replace('### ', '')}</h4>;
      }
      if (line.startsWith('## ')) {
        return <h3 key={idx} style={{ fontSize: 16, fontWeight: 700, margin: '12px 0 6px', color: '#fff' }}>{line.replace('## ', '')}</h3>;
      }
      if (line.startsWith('- ')) {
        return (
          <li key={idx} style={{ marginLeft: 16, listStyleType: 'disc', color: 'rgba(255,255,255,0.9)' }}>
            {formatInline(line.substring(2))}
          </li>
        );
      }
      if (line.trim() === '---') {
        return <hr key={idx} style={{ borderColor: 'rgba(255,255,255,0.12)', margin: '12px 0' }} />;
      }
      return <p key={idx} style={{ margin: '4px 0', minHeight: line.trim() ? 'auto' : 8 }}>{formatInline(line)}</p>;
    });
  };

  const formatInline = (str: string) => {
    // Regex for bold **text** and code `code`
    const parts = str.split(/(\*\*.*?\*\*|`.*?`)/g);
    return parts.map((part, i) => {
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={i} style={{ color: '#fff', fontWeight: 600 }}>{part.slice(2, -2)}</strong>;
      }
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={i} style={{
            background: 'rgba(255,255,255,0.12)',
            padding: '2px 6px',
            borderRadius: 4,
            fontFamily: 'monospace',
            fontSize: 12,
            color: '#a7f3d0',
          }}>
            {part.slice(1, -1)}
          </code>
        );
      }
      return part;
    });
  };

  return (
    <div
      style={{ position: 'relative', height: '100vh', overflow: 'hidden', background: '#000', display: 'flex' }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Video background */}
      <video
        style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none', zIndex: 0 }}
        autoPlay muted loop playsInline
      >
        <source src={VIDEO_URL} type="video/mp4" />
      </video>
      {/* Scrim */}
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 0, pointerEvents: 'none' }} />

      {/* ── Drag overlay ── */}
      {isDragging && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 50,
          background: 'rgba(0,0,0,0.75)',
          backdropFilter: 'blur(20px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            ...frost(0.12, 28),
            borderRadius: 28, padding: '48px 64px',
            textAlign: 'center',
            border: '2px dashed rgba(255,255,255,0.3)',
            boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
          }}>
            <UploadCloud size={52} color="#60a5fa" style={{ margin: '0 auto' }} />
            <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 16, color: '#fff' }}>Drop documents to ingest</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>
              PDF, Excel, Word, PowerPoint, OCR Scans, Images, CSV
            </p>
          </div>
        </div>
      )}

      {/* ── Sidebar ── */}
      <aside style={{
        ...frost(0.07, 24),
        width: 250,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        margin: '12px 0 12px 12px',
        borderRadius: 22,
        boxShadow: '0 8px 32px rgba(0,0,0,0.35)',
        position: 'relative',
        zIndex: 1,
      }}
        className="hidden-mobile"
      >
        {/* Brand header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%', background: '#fff',
            display: 'grid', placeItems: 'center', color: '#000', flexShrink: 0,
          }}>
            <Sparkles size={16} />
          </div>
          <div>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 16, fontWeight: 700, letterSpacing: '-0.02em', color: '#fff' }}>
              FaZe DocAgent
            </span>
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Document Intelligence</div>
          </div>
        </div>

        <Link to="/" style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 16px', color: 'rgba(255,255,255,0.5)', fontSize: 12,
          textDecoration: 'none', transition: 'color 0.2s',
        }}
          onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
          onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.5)')}
        >
          <ArrowLeft size={13} /> Back to Home
        </Link>

        {/* New chat */}
        <button
          onClick={startNewChat}
          style={{
            ...frost(0.06, 12),
            margin: '8px 12px', display: 'flex', alignItems: 'center',
            justifyContent: 'center', gap: 8, padding: '10px',
            borderRadius: 14, color: '#fff', fontSize: 13, fontWeight: 500,
            cursor: 'pointer', transition: 'background 0.2s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.12)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.06)')}
        >
          <Plus size={14} /> New Chat & Reset
        </button>

        {/* Ingested Documents List */}
        <div style={{ padding: '8px 16px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)' }}>
            Active Docs ({ingestedDocs.length})
          </span>
          <button onClick={fetchStatus} title="Refresh status" style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: 0 }}>
            <RefreshCw size={11} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {ingestedDocs.length === 0 ? (
            <p style={{ padding: '12px 8px', fontSize: 12, color: 'rgba(255,255,255,0.35)', textAlign: 'center', fontStyle: 'italic' }}>
              No documents ingested yet.<br />Attach or drop files to start.
            </p>
          ) : (
            ingestedDocs.map((doc, idx) => (
              <div
                key={idx}
                style={{
                  ...frost(0.04, 8),
                  padding: '7px 10px',
                  borderRadius: 10,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', flex: 1 }}>
                  <FileText size={13} style={{ color: '#93c5fd', flexShrink: 0 }} />
                  <div style={{ overflow: 'hidden', flex: 1 }}>
                    <div style={{ fontSize: 12, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {doc.filename}
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', display: 'flex', gap: 6, marginTop: 2 }}>
                      <span style={{ textTransform: 'uppercase', color: '#6ee7b7' }}>{doc.pipeline}</span>
                      <span>• {doc.chunk_count} chunks</span>
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleDeleteDoc(doc.filename)}
                  title={`Remove ${doc.filename} from index`}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'rgba(255,255,255,0.3)',
                    cursor: 'pointer',
                    padding: 2,
                    display: 'flex',
                    alignItems: 'center',
                    flexShrink: 0,
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#f87171')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.3)')}
                >
                  <X size={12} />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Recent Chat History */}
        {chatHistory.length > 0 && (
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', padding: '8px', maxHeight: 120, overflowY: 'auto' }}>
            <p style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.25)', padding: '4px 8px' }}>
              Recent Questions
            </p>
            {chatHistory.map((title, i) => (
              <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', padding: '3px 8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                • {title}
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* ── Main chat ── */}
      <div style={{
        ...frost(0.06, 20),
        flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0,
        margin: '12px', borderRadius: 22,
        boxShadow: '0 8px 40px rgba(0,0,0,0.35)',
        position: 'relative', zIndex: 1,
        overflow: 'hidden',
      }}>
        {/* Topbar */}
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '14px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          flexShrink: 0,
          background: 'rgba(0,0,0,0.25)',
          backdropFilter: 'blur(16px)',
        }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#fff', display: 'grid', placeItems: 'center', color: '#000' }}>
            <Layers size={14} />
          </div>
          <div>
            <span style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 600, color: '#fff' }}>
              Multi-Source Grounded QA
            </span>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
              Deterministic Validation • Strict Evidence Attribution • Conflict Detection
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: backendStatus?.status === 'online' ? '#4ade80' : '#f59e0b',
              animation: 'pulse-status 2s ease-in-out infinite', display: 'inline-block',
            }} />
            <span>{backendStatus?.model || 'Connecting...'}</span>
          </div>
        </header>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
              {/* Avatar */}
              <div style={{
                width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                marginTop: 2, display: 'grid', placeItems: 'center',
                ...(msg.role === 'assistant'
                  ? { background: '#fff', color: '#000' }
                  : { background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.16)', color: '#fff' }),
              }}>
                {msg.role === 'assistant' ? <FileText size={14} /> : <User size={14} />}
              </div>

              {/* Message Bubble Container */}
              <div style={{ maxWidth: '78%', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{
                  padding: '14px 20px', fontSize: 14, lineHeight: 1.65,
                  ...(msg.role === 'assistant'
                    ? {
                      ...frost(0.09, 16),
                      borderRadius: '18px 18px 18px 4px',
                      color: 'rgba(255,255,255,0.92)',
                      boxShadow: '0 2px 14px rgba(0,0,0,0.25)',
                    }
                    : {
                      background: '#fff',
                      color: '#111',
                      fontWeight: 500,
                      borderRadius: '18px 18px 4px 18px',
                      boxShadow: '0 2px 16px rgba(0,0,0,0.25)',
                    }),
                }}>
                  {renderFormatted(msg.content)}

                  {/* Conflict Detection Banner & Optional Resolution Action */}
                  {msg.conflicting && (
                    <div style={{
                      marginTop: 14,
                      padding: 12,
                      borderRadius: 12,
                      background: 'rgba(245, 158, 11, 0.15)',
                      border: '1px solid rgba(245, 158, 11, 0.3)',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#fde68a', fontWeight: 600, fontSize: 13 }}>
                        <AlertTriangle size={15} /> Contradiction Detected Across Documents
                      </div>
                      <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>
                        Uploaded sources disagree on this fact. You can trigger an authoritative LLM Search to resolve this conflict.
                      </p>
                      <button
                        onClick={() => handleResolveConflict(i, msg.originalQuestion || '', msg.content)}
                        disabled={resolvingIdx === i}
                        style={{
                          marginTop: 8,
                          padding: '6px 12px',
                          borderRadius: 8,
                          background: '#f59e0b',
                          color: '#000',
                          fontWeight: 600,
                          fontSize: 12,
                          border: 'none',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        {resolvingIdx === i ? <RefreshCw size={12} className="animate-spin" /> : <Sparkles size={12} />}
                        {resolvingIdx === i ? 'Resolving Conflict...' : 'Resolve Conflict via LLM Search'}
                      </button>
                    </div>
                  )}
                </div>

                {/* Grounded Citations & Provenance Badges */}
                {msg.citations && msg.citations.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingLeft: 4 }}>
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', alignSelf: 'center', marginRight: 2 }}>
                      Sources:
                    </span>
                    {msg.citations.map((c, cIdx) => (
                      <span
                        key={cIdx}
                        title={c.snippet || 'Grounded citation source'}
                        style={{
                          fontSize: 11,
                          padding: '3px 8px',
                          borderRadius: 6,
                          background: 'rgba(59, 130, 246, 0.15)',
                          border: '1px solid rgba(59, 130, 246, 0.3)',
                          color: '#93c5fd',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                        }}
                      >
                        <FileText size={10} />
                        {c.filename} {c.page ? `(p. ${c.page})` : ''}
                      </span>
                    ))}
                  </div>
                )}

                {/* Computational Evidence Accordion / Audit Trail */}
                {msg.evidence && msg.evidence.length > 0 && (
                  <details style={{
                    ...frost(0.05, 12),
                    borderRadius: 10,
                    padding: '8px 12px',
                    fontSize: 12,
                    color: 'rgba(255,255,255,0.8)',
                    cursor: 'pointer',
                  }}>
                    <summary style={{ fontWeight: 600, color: '#93c5fd', outline: 'none', userSelect: 'none' }}>
                      📊 Computational Evidence & Audit Trail ({msg.evidence.length} record{msg.evidence.length > 1 ? 's' : ''})
                    </summary>
                    <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 180, overflowY: 'auto' }}>
                      {msg.evidence.map((ev, eIdx) => (
                        <div key={eIdx} style={{
                          background: 'rgba(0,0,0,0.3)',
                          borderRadius: 6,
                          padding: '6px 8px',
                          fontFamily: 'monospace',
                          fontSize: 11,
                          color: '#e2e8f0',
                        }}>
                          {ev.operation && <div><strong style={{ color: '#a7f3d0' }}>Operation:</strong> {ev.operation}</div>}
                          {ev.sheet && <div><strong>Sheet:</strong> {ev.sheet}</div>}
                          {ev.columns && <div><strong>Columns:</strong> {Array.isArray(ev.columns) ? ev.columns.join(', ') : JSON.stringify(ev.columns)}</div>}
                          {ev.rows_analyzed !== undefined && <div><strong>Rows Analyzed:</strong> {ev.rows_analyzed}</div>}
                          {ev.result !== undefined && <div><strong>Formula / Result:</strong> {JSON.stringify(ev.result)}</div>}
                          {!ev.operation && <div>{JSON.stringify(ev)}</div>}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            </div>
          ))}

          {/* Thinking / Loading Animation */}
          {isThinking && (
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: '#fff', color: '#000', display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 2 }}>
                <FileText size={14} />
              </div>
              <div style={{
                ...frost(0.09, 16),
                borderRadius: '18px 18px 18px 4px',
                padding: '14px 20px',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', marginRight: 6 }}>
                  Analyzing documents across pipelines...
                </span>
                {[0, 1, 2].map(idx => (
                  <span key={idx} style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: 'rgba(255,255,255,0.7)',
                    display: 'inline-block',
                    animation: `thinking-bounce 1.4s ease-in-out ${idx * 0.16}s infinite`,
                  }} />
                ))}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Dock */}
        <div style={{ padding: '14px 18px 18px', flexShrink: 0 }}>
          {/* File pills */}
          {files.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {files.map((f, idx) => (
                <div key={idx} style={{
                  ...frost(0.08, 10),
                  display: 'flex', alignItems: 'center', gap: 6,
                  borderRadius: 8, padding: '5px 10px', fontSize: 12, color: 'rgba(255,255,255,0.7)',
                }}>
                  <Paperclip size={11} />
                  <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.name}
                  </span>
                  <button onClick={() => removeFile(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.5)', display: 'flex', padding: 0 }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.5)')}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input Box */}
          <div style={{
            ...frost(0.08, 20),
            display: 'flex', alignItems: 'flex-end', gap: 8,
            borderRadius: 20, padding: 8,
            maxWidth: 820, margin: '0 auto',
            boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
          }}>
            {/* Upload Button */}
            <label style={{
              padding: 10, borderRadius: 10,
              background: 'transparent', cursor: 'pointer',
              color: isUploading ? '#60a5fa' : 'rgba(255,255,255,0.5)',
              display: 'flex', alignItems: 'center',
              transition: 'background 0.15s, color 0.15s', flexShrink: 0,
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLLabelElement).style.background = 'rgba(255,255,255,0.08)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLLabelElement).style.background = 'transparent'; }}
              title="Attach documents (PDF, Excel, Word, PPT, Image, CSV)"
            >
              <UploadCloud size={18} className={isUploading ? 'animate-pulse' : ''} />
              <input
                type="file" multiple style={{ display: 'none' }}
                onChange={handleFileChange}
                accept=".pdf,.png,.jpg,.jpeg,.webp,.bmp,.tiff,.gif,.csv,.tsv,.xlsx,.xls,.xlsm,.docx,.doc,.docs,.pptx,.ppt,.txt,.md,.json"
              />
            </label>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything about your documents, datasets, or drop files here..."
              rows={1}
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                resize: 'none', color: '#fff', fontFamily: 'var(--font-sans)',
                fontSize: 14, lineHeight: 1.6, padding: '10px 8px',
                maxHeight: 160, overflowY: 'auto', minHeight: 44,
              }}
            />

            <button
              onClick={handleSend}
              disabled={!input.trim() && files.length === 0}
              style={{
                width: 38, height: 38, background: '#fff', color: '#111',
                border: 'none', borderRadius: 10, display: 'grid',
                placeItems: 'center', cursor: 'pointer', flexShrink: 0,
                transition: 'background 0.15s, transform 0.15s',
                opacity: (!input.trim() && files.length === 0) ? 0.25 : 1,
                boxShadow: '0 2px 10px rgba(255,255,255,0.15)',
              }}
              onMouseEnter={e => {
                if (input.trim() || files.length) {
                  (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.08)';
                }
              }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'none'; }}
            >
              <Send size={16} />
            </button>
          </div>

          <p style={{ textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.25)', marginTop: 10 }}>
            FaZe Document Intelligence • 3-Layer Anti-Hallucination Guardrails Active
          </p>
        </div>
      </div>

      {/* Inline styles for animations */}
      <style>{`
        @keyframes pulse-status {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes thinking-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-6px); opacity: 1; }
        }
        .hidden-mobile { display: flex; flex-direction: column; }
        @media (max-width: 720px) { .hidden-mobile { display: none !important; } }
      `}</style>
    </div>
  );
}
