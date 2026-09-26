import React, { useState, useRef, useEffect } from 'react';
import {
  UploadCloud, MessageSquare, ArrowLeft, Send,
  FileText, X, Paperclip, Plus, User, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';

const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4';

const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

const getGeminiResponse = async (
  history: { role: string; content: string }[],
  newMessage: string
) => {
  if (!apiKey) {
    return "I'm running in demo mode. Add `VITE_GEMINI_API_KEY=your_key` to `.env` to unlock Gemini.";
  }
  try {
    const formatted = history
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));
    formatted.push({ role: 'user', parts: [{ text: newMessage }] });

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: formatted }),
      }
    );

    if (!res.ok) {
      const err = await res.json();
      console.error('Gemini API Error:', err);
      // Provide a mock response so the UI remains interactive if the API key is invalid
      return `[Demo Response] I received your request: "${newMessage.slice(0, 50)}...". (The Gemini API key provided is invalid or encountering an error).`;
    }
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response received.';
  } catch (e) {
    console.error('Fetch error:', e);
    return 'A network error occurred while reaching Gemini. Are you offline?';
  }
};

type Message = { role: 'user' | 'assistant'; content: string };
type ChatSession = { id: string; title: string; messages: Message[] };

/* ── Glass style helpers ── */
const frost = (alpha = 0.08, blur = 24) => ({
  background: `rgba(255,255,255,${alpha})`,
  border: '1px solid rgba(255,255,255,0.14)',
  backdropFilter: `blur(${blur}px) saturate(180%)`,
  WebkitBackdropFilter: `blur(${blur}px) saturate(180%)`,
} as React.CSSProperties);

const WELCOME_MSG: Message = {
  role: 'assistant',
  content: 'Hello! I am Birbal. Upload a document — PDF, image, Excel, or text — and ask me anything about its contents.',
};

export default function ChatPage() {
  const [isDragging, setIsDragging] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [chatSessions, setChatSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([WELCOME_MSG]);
  const [input, setInput] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const location = useLocation();
  const isWorkspace = new URLSearchParams(location.search).get('workspace') === 'true';

  useEffect(() => {
    if (isWorkspace && messages.length === 1) {
      setMessages([{
        role: 'assistant',
        content: 'I have loaded your Community Workspace files. How can I help you analyze them today?'
      }]);
    }
  }, [isWorkspace]);

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
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setIsDragging(false);
    if (e.dataTransfer.files.length > 0)
      setFiles(prev => [...prev, ...Array.from(e.dataTransfer.files)]);
  };
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length)
      setFiles(prev => [...prev, ...Array.from(e.target.files!)]);
  };
  const removeFile = (i: number) => setFiles(prev => prev.filter((_, idx) => idx !== i));

  const handleSend = async () => {
    if (!input.trim() && files.length === 0) return;
    const text = input.trim();
    const names = files.map(f => f.name);
    const userContent = files.length
      ? text ? `${text}\n[Attached: ${names.join(', ')}]` : `[Attached: ${names.join(', ')}]`
      : text;

    const next: Message[] = [...messages, { role: 'user', content: userContent }];
    setMessages(next);
    setInput('');
    setFiles([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    setIsThinking(true);

    // Create/update session in history
    const updatedMessages: Message[] = [...next];
    if (activeSessionId) {
      setChatSessions(prev => prev.map(s =>
        s.id === activeSessionId ? { ...s, messages: updatedMessages } : s
      ));
    } else {
      const title = text ? text.slice(0, 32) : names.length > 0 ? names[0] : 'New Chat';
      const newId = Date.now().toString();
      setActiveSessionId(newId);
      setChatSessions(prev => [{ id: newId, title, messages: updatedMessages }, ...prev]);
    }

    const reply = await getGeminiResponse(messages, userContent);
    setIsThinking(false);
    setMessages(prev => [...prev, { role: 'assistant', content: reply }]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const startNewChat = () => {
    setActiveSessionId(null);
    setMessages([WELCOME_MSG]);
    setFiles([]); setInput('');
  };

  const loadSession = (session: ChatSession) => {
    setActiveSessionId(session.id);
    setMessages(session.messages);
    setFiles([]); setInput('');
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
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 0, pointerEvents: 'none' }} />

      {/* ── Drag overlay ── */}
      {isDragging && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 50,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(20px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            ...frost(0.1, 28),
            borderRadius: 28, padding: '48px 64px',
            textAlign: 'center',
            border: '2px dashed rgba(255,255,255,0.25)',
            boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
          }}>
            <UploadCloud size={52} color="white" style={{ margin: '0 auto' }} />
            <h2 style={{ fontSize: 20, fontWeight: 600, marginTop: 16, color: '#fff' }}>Drop documents here</h2>
            <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>PDF, Images, Excel, Word, CSV</p>
          </div>
        </div>
      )}

      {/* ── Sidebar ── */}
      <aside style={{
        ...frost(0.07, 24),
        width: isSidebarOpen ? 234 : 0,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        margin: isSidebarOpen ? '12px 0 12px 12px' : '12px 0',
        borderRadius: 22,
        boxShadow: isSidebarOpen ? '0 8px 32px rgba(0,0,0,0.35)' : 'none',
        position: 'relative',
        zIndex: 1,
        overflow: 'hidden',
        transition: 'width 0.28s cubic-bezier(0.4,0,0.2,1), margin 0.28s cubic-bezier(0.4,0,0.2,1), box-shadow 0.28s ease',
        opacity: isSidebarOpen ? 1 : 0,
      }}
        className="hidden-mobile"
      >
        {/* Logo row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{
            width: 30, height: 30, borderRadius: '50%', background: '#fff',
            display: 'grid', placeItems: 'center', color: '#000', flexShrink: 0,
          }}>
            <FileText size={14} />
          </div>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 16, letterSpacing: '-0.03em', color: '#fff' }}>
            Birbal
          </span>
        </div>

        <Link to="/" style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '8px 16px', color: 'var(--muted)', fontSize: 12,
          textDecoration: 'none', transition: 'color 0.2s',
        }}
          onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--muted)')}
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
          <Plus size={14} /> New Chat
        </button>

        {/* History */}
        <p style={{ padding: '6px 16px 4px', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.25)' }}>
          Recent
        </p>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
          {chatSessions.length === 0 && (
            <p style={{ padding: '10px 8px', fontSize: 12, color: 'var(--muted)', textAlign: 'center', opacity: 0.7 }}>
              No recent chats
            </p>
          )}
          {chatSessions.map((session) => (
            <button key={session.id}
              onClick={() => loadSession(session)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '8px 10px', borderRadius: 10,
                background: activeSessionId === session.id ? 'rgba(255,255,255,0.10)' : 'transparent',
                border: activeSessionId === session.id ? '1px solid rgba(255,255,255,0.12)' : '1px solid transparent',
                color: activeSessionId === session.id ? '#fff' : 'var(--muted)',
                fontSize: 13, cursor: 'pointer',
                textAlign: 'left', overflow: 'hidden', transition: 'background 0.15s, color 0.15s',
              }}
              onMouseEnter={e => { if (activeSessionId !== session.id) { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = '#fff'; } }}
              onMouseLeave={e => { if (activeSessionId !== session.id) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--muted)'; } }}
            >
              <MessageSquare size={12} style={{ opacity: 0.5, flexShrink: 0 }} />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{session.title}</span>
            </button>
          ))}
        </div>
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
          background: 'rgba(0,0,0,0.2)',
          backdropFilter: 'blur(16px)',
        }}>
          {/* Sidebar toggle */}
          <button
            onClick={() => setIsSidebarOpen(o => !o)}
            title={isSidebarOpen ? 'Close sidebar' : 'Open sidebar'}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'rgba(255,255,255,0.55)', display: 'flex', alignItems: 'center',
              padding: 6, borderRadius: 8, transition: 'color 0.2s, background 0.2s', flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
            onMouseLeave={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.55)'; e.currentTarget.style.background = 'none'; }}
          >
            {isSidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
          </button>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#fff', display: 'grid', placeItems: 'center', color: '#000' }}>
            <FileText size={13} />
          </div>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 15, letterSpacing: '-0.03em', color: '#fff' }}>
            Birbal
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>
            {isWorkspace && (
              <span style={{ 
                background: 'rgba(255,255,255,0.1)', color: '#fff', 
                padding: '4px 8px', borderRadius: 4, marginRight: 8 
              }}>
                Community Workspace
              </span>
            )}
            <span style={{
              width: 6, height: 6, borderRadius: '50%', background: '#4ade80',
              animation: 'pulse-status 2s ease-in-out infinite', display: 'inline-block',
            }} />
            Active
          </div>
        </header>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, flexDirection: msg.role === 'user' ? 'row-reverse' : 'row' }}>
              {/* Avatar */}
              <div style={{
                width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                marginTop: 2, display: 'grid', placeItems: 'center',
                ...(msg.role === 'assistant'
                  ? { background: '#fff', color: '#000' }
                  : { background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.16)', color: '#fff' }),
              }}>
                {msg.role === 'assistant' ? <FileText size={13} /> : <User size={13} />}
              </div>
              {/* Bubble */}
              <div style={{
                maxWidth: '68%', padding: '12px 18px', fontSize: 16, lineHeight: 1.7,
                ...(msg.role === 'assistant'
                  ? {
                    ...frost(0.09, 16),
                    borderRadius: '18px 18px 18px 4px',
                    color: 'rgba(255,255,255,0.92)',
                    boxShadow: '0 2px 12px rgba(0,0,0,0.2)',
                  }
                  : {
                    background: '#fff',
                    color: '#111',
                    fontWeight: 500,
                    borderRadius: '18px 18px 4px 18px',
                    border: 'none',
                    boxShadow: '0 2px 16px rgba(0,0,0,0.25)',
                  }),
              }}>
                {msg.content}
              </div>
            </div>
          ))}

          {/* Thinking */}
          {isThinking && (
            <div style={{ display: 'flex', gap: 10 }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#fff', color: '#000', display: 'grid', placeItems: 'center', flexShrink: 0, marginTop: 2 }}>
                <FileText size={13} />
              </div>
              <div style={{
                ...frost(0.09, 16),
                borderRadius: '18px 18px 18px 4px',
                padding: '14px 18px',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                {[0, 1, 2].map(i => (
                  <span key={i} style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: 'rgba(255,255,255,0.5)',
                    display: 'inline-block',
                    animation: `thinking-bounce 1.4s ease-in-out ${i * 0.16}s infinite`,
                  }} />
                ))}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div style={{ padding: '14px 18px 18px', flexShrink: 0 }}>
          {/* File pills */}
          {files.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {files.map((f, i) => (
                <div key={i} style={{
                  ...frost(0.07, 10),
                  display: 'flex', alignItems: 'center', gap: 6,
                  borderRadius: 8, padding: '5px 10px', fontSize: 12, color: 'var(--muted)',
                }}>
                  <Paperclip size={11} />
                  <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <button onClick={() => removeFile(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', display: 'flex', padding: 0 }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--muted)')}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input box */}
          <div style={{
            ...frost(0.08, 20),
            display: 'flex', alignItems: 'flex-end', gap: 8,
            borderRadius: 20, padding: 8,
            maxWidth: 820, margin: '0 auto',
            boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
            transition: 'border-color 0.2s',
          }}>
            {/* Upload */}
            <label style={{
              padding: 10, borderRadius: 10,
              background: 'transparent', cursor: 'pointer',
              color: 'var(--muted)', display: 'flex', alignItems: 'center',
              transition: 'background 0.15s, color 0.15s', flexShrink: 0,
            }}
              onMouseEnter={e => { (e.currentTarget as HTMLLabelElement).style.background = 'rgba(255,255,255,0.08)'; (e.currentTarget as HTMLLabelElement).style.color = '#fff'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLLabelElement).style.background = 'transparent'; (e.currentTarget as HTMLLabelElement).style.color = 'var(--muted)'; }}
              title="Attach files"
            >
              <UploadCloud size={18} />
              <input
                type="file" multiple style={{ display: 'none' }}
                onChange={handleFileChange}
                accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.csv,.txt"
              />
            </label>

            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything about your documents… or drop files here"
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

          <p style={{ textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.22)', marginTop: 10 }}>
            Birbal may make mistakes. Verify important information.
          </p>
        </div>
      </div>

      {/* Inline keyframes */}
      <style>{`
        @keyframes pulse-status {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes thinking-bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-6px); opacity: 1; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .hidden-mobile { display: flex; flex-direction: column; }
        @media (max-width: 720px) { .hidden-mobile { display: none !important; } }
      `}</style>
    </div>
  );
}
