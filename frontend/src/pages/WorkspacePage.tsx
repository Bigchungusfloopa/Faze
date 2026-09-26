import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import {
  Users, FolderOpen, UploadCloud, Shield,
  MessageSquare, UserPlus, FileText, Trash2,
  Plus, ArrowLeft, Hash, Check
} from 'lucide-react';

const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4';

const COMMUNITY_THEMES = [
  { accent: 'rgba(139,92,246,0.18)',  border: 'rgba(139,92,246,0.35)',  tag: '#a78bfa', label: 'Violet'  },
  { accent: 'rgba(59,130,246,0.18)',  border: 'rgba(59,130,246,0.35)',  tag: '#60a5fa', label: 'Blue'    },
  { accent: 'rgba(16,185,129,0.18)',  border: 'rgba(16,185,129,0.35)',  tag: '#34d399', label: 'Emerald' },
  { accent: 'rgba(245,158,11,0.18)',  border: 'rgba(245,158,11,0.35)',  tag: '#fbbf24', label: 'Amber'   },
  { accent: 'rgba(239,68,68,0.18)',   border: 'rgba(239,68,68,0.35)',   tag: '#f87171', label: 'Rose'    },
  { accent: 'rgba(6,182,212,0.18)',   border: 'rgba(6,182,212,0.35)',   tag: '#22d3ee', label: 'Cyan'    },
];

type Member    = { id: string; name: string; email: string; role: 'Admin' | 'Editor' | 'Viewer' };
type WFile     = { id: string; name: string; size: string; date: string };
type Community = { id: string; name: string; themeIdx: number; members: Member[]; files: WFile[] };

const makeId = () => Math.random().toString(36).slice(2, 9);

const INITIAL: Community[] = [
  {
    id: makeId(), name: 'Research Team', themeIdx: 0,
    members: [
      { id: '1', name: 'Alex Rivera',  email: 'alex@example.com',   role: 'Admin'  },
      { id: '2', name: 'Jordan Lee',   email: 'jordan@example.com', role: 'Editor' },
    ],
    files: [{ id: 'f1', name: 'Research_Overview.pdf', size: '3.1 MB', date: 'Sep 25, 2026' }],
  },
  {
    id: makeId(), name: 'Legal Docs', themeIdx: 4,
    members: [{ id: '3', name: 'Sam Taylor', email: 'sam@example.com', role: 'Viewer' }],
    files: [
      { id: 'f2', name: 'NDA_2026.docx',         size: '0.8 MB', date: 'Sep 20, 2026' },
      { id: 'f3', name: 'Compliance_Audit.xlsx', size: '1.4 MB', date: 'Sep 18, 2026' },
    ],
  },
];

const frost = (alpha = 0.07, blur = 24, border = 'rgba(255,255,255,0.12)') =>
  ({
    background: `rgba(255,255,255,${alpha})`,
    border: `1px solid ${border}`,
    backdropFilter: `blur(${blur}px) saturate(180%)`,
    WebkitBackdropFilter: `blur(${blur}px) saturate(180%)`,
  } as React.CSSProperties);

export default function WorkspacePage() {
  const navigate = useNavigate();
  const [communities, setCommunities] = useState<Community[]>(INITIAL);
  const [active, setActive] = useState<string | null>(null);
  const [tab, setTab] = useState<'files' | 'members'>('files');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTheme, setNewTheme] = useState(0);

  const createCommunity = () => {
    if (!newName.trim()) return;
    const c: Community = { id: makeId(), name: newName.trim(), themeIdx: newTheme, members: [], files: [] };
    setCommunities(prev => [c, ...prev]);
    setNewName('');
    setCreating(false);
    setActive(c.id);
  };

  const activeCommunity = communities.find(c => c.id === active) ?? null;

  const updateCommunity = (id: string, updater: (c: Community) => Community) =>
    setCommunities(prev => prev.map(c => (c.id === id ? updater(c) : c)));

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!active || !e.target.files?.length) return;
    const newFiles = Array.from(e.target.files).map(f => ({
      id: makeId(), name: f.name,
      size: (f.size / 1024 / 1024).toFixed(2) + ' MB',
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    }));
    updateCommunity(active, c => ({ ...c, files: [...newFiles, ...c.files] }));
  };

  const removeFile   = (fileId: string)   => active && updateCommunity(active, c => ({ ...c, files:   c.files.filter(f => f.id !== fileId)   }));
  const removeMember = (memberId: string) => active && updateCommunity(active, c => ({ ...c, members: c.members.filter(m => m.id !== memberId) }));
  const updateRole   = (memberId: string, role: Member['role']) =>
    active && updateCommunity(active, c => ({ ...c, members: c.members.map(m => m.id === memberId ? { ...m, role } : m) }));
  const deleteCommunity = (id: string) => { setCommunities(prev => prev.filter(c => c.id !== id)); if (active === id) setActive(null); };

  const theme = activeCommunity ? COMMUNITY_THEMES[activeCommunity.themeIdx] : null;

  return (
    <div style={{ position: 'relative', minHeight: '100vh', overflow: 'hidden', background: '#000', display: 'flex', flexDirection: 'column' }}>
      <video style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none', zIndex: 0 }} autoPlay muted loop playsInline>
        <source src={VIDEO_URL} type="video/mp4" />
      </video>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.62)', zIndex: 0, pointerEvents: 'none' }} />

      {/* Header */}
      <header style={{ position: 'relative', zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 40px', maxWidth: 1200, width: '100%', margin: '0 auto' }}>
        <Link to="/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none' }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#fff', display: 'grid', placeItems: 'center', color: '#000' }}><FileText size={16} /></div>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: 18, color: '#fff', letterSpacing: '-0.02em' }}>Birbal</span>
        </Link>
        <nav style={{ display: 'flex', gap: 4, ...frost(0.05, 12), padding: 6, borderRadius: 999 }}>
          <Link to="/"     style={{ padding: '8px 16px', color: '#ccc', textDecoration: 'none', fontSize: 14, borderRadius: 999 }}>Home</Link>
          <div             style={{ padding: '8px 16px', color: '#fff', fontSize: 14, borderRadius: 999, background: 'rgba(255,255,255,0.10)' }}>Workspace</div>
          <Link to="/chat" style={{ padding: '8px 16px', color: '#ccc', textDecoration: 'none', fontSize: 14, borderRadius: 999 }}>Chat</Link>
        </nav>
      </header>

      <main style={{ position: 'relative', zIndex: 10, flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '20px 20px 48px' }}>

        {/* ====== LIST VIEW ====== */}
        {!active && (
          <div style={{ width: '100%', maxWidth: 900 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
              <div>
                <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 30, color: '#fff', margin: 0, letterSpacing: '-0.03em' }}>Communities</h1>
                <p style={{ color: 'var(--muted)', fontSize: 14, marginTop: 6 }}>Create and manage shared workspaces for your teams.</p>
              </div>
              <button onClick={() => setCreating(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', color: '#000', border: 'none', padding: '10px 18px', borderRadius: 12, fontWeight: 600, fontSize: 14, cursor: 'pointer', transition: 'transform 0.2s' }}
                onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.04)'}
                onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
              >
                <Plus size={16} /> New Community
              </button>
            </div>

            {creating && (
              <div style={{ ...frost(0.06, 28, 'rgba(255,255,255,0.15)'), borderRadius: 20, padding: '24px 28px', marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div style={{ color: '#fff', fontWeight: 600, fontSize: 16 }}>New Community</div>
                <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createCommunity()} placeholder="Community name…" autoFocus
                  style={{ background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.15)', borderRadius: 10, padding: '10px 14px', color: '#fff', fontSize: 15, outline: 'none', width: '100%' }} />
                <div>
                  <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 10 }}>Choose a colour theme</p>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {COMMUNITY_THEMES.map((t, i) => (
                      <button key={i} onClick={() => setNewTheme(i)} title={t.label} style={{ width: 32, height: 32, borderRadius: '50%', border: newTheme === i ? `2px solid ${t.tag}` : '2px solid transparent', background: t.accent, cursor: 'pointer', outline: 'none', display: 'grid', placeItems: 'center', transform: newTheme === i ? 'scale(1.2)' : 'scale(1)', transition: 'transform 0.15s' }}>
                        {newTheme === i && <Check size={14} color={t.tag} />}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={createCommunity} style={{ flex: 1, background: '#fff', color: '#000', border: 'none', padding: '10px', borderRadius: 10, fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>Create</button>
                  <button onClick={() => { setCreating(false); setNewName(''); }} style={{ ...frost(0.05, 10), color: '#fff', border: 'none', padding: '10px 18px', borderRadius: 10, fontSize: 14, cursor: 'pointer' }}>Cancel</button>
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 20 }}>
              {communities.map(c => {
                const t = COMMUNITY_THEMES[c.themeIdx];
                return (
                  <div key={c.id} onClick={() => { setActive(c.id); setTab('files'); }}
                    style={{ background: t.accent, border: `1px solid ${t.border}`, backdropFilter: 'blur(28px) saturate(200%)', WebkitBackdropFilter: 'blur(28px) saturate(200%)', borderRadius: 20, padding: '24px 22px', cursor: 'pointer', transition: 'transform 0.2s, box-shadow 0.2s', boxShadow: '0 8px 32px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', gap: 14, position: 'relative' }}
                    onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-4px)'; e.currentTarget.style.boxShadow = '0 16px 40px rgba(0,0,0,0.4)'; }}
                    onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 8px 32px rgba(0,0,0,0.3)'; }}
                  >
                    <button onClick={e => { e.stopPropagation(); deleteCommunity(c.id); }} style={{ position: 'absolute', top: 14, right: 14, background: 'rgba(0,0,0,0.2)', border: 'none', borderRadius: 6, padding: 5, cursor: 'pointer', color: 'rgba(255,255,255,0.4)', transition: 'color 0.2s' }}
                      onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                      onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'}
                    ><Trash2 size={13} /></button>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 12, background: t.border, display: 'grid', placeItems: 'center' }}><Hash size={20} color={t.tag} /></div>
                      <div>
                        <div style={{ color: '#fff', fontWeight: 700, fontSize: 16 }}>{c.name}</div>
                        <div style={{ color: t.tag, fontSize: 11, fontWeight: 500, marginTop: 2 }}>{t.label}</div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 16 }}>
                      <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 5 }}><FileText size={13} /> {c.files.length} file{c.files.length !== 1 ? 's' : ''}</span>
                      <span style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 5 }}><Users size={13} /> {c.members.length} member{c.members.length !== 1 ? 's' : ''}</span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex' }}>
                        {c.members.slice(0, 4).map((m, i) => (
                          <div key={m.id} title={m.name} style={{ width: 26, height: 26, borderRadius: '50%', background: 'rgba(255,255,255,0.15)', border: '2px solid rgba(0,0,0,0.4)', display: 'grid', placeItems: 'center', color: '#fff', fontSize: 11, fontWeight: 600, marginLeft: i === 0 ? 0 : -8, zIndex: i }}>
                            {m.name.charAt(0)}
                          </div>
                        ))}
                      </div>
                      <span style={{ fontSize: 12, color: t.tag, fontWeight: 500 }}>Open →</span>
                    </div>
                  </div>
                );
              })}
              {communities.length === 0 && (
                <div style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--muted)', padding: '48px 0', fontSize: 15 }}>No communities yet. Create your first one!</div>
              )}
            </div>
          </div>
        )}

        {/* ====== DETAIL VIEW ====== */}
        {active && activeCommunity && theme && (
          <div style={{ width: '100%', maxWidth: 800 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
              <div>
                <button onClick={() => setActive(null)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--muted)', fontSize: 13, cursor: 'pointer', marginBottom: 10, padding: 0 }}
                  onMouseEnter={e => e.currentTarget.style.color = '#fff'}
                  onMouseLeave={e => e.currentTarget.style.color = 'var(--muted)'}
                ><ArrowLeft size={14} /> All Communities</button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 44, height: 44, borderRadius: 14, background: theme.border, display: 'grid', placeItems: 'center' }}><Hash size={22} color={theme.tag} /></div>
                  <div>
                    <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 26, color: '#fff', margin: 0 }}>{activeCommunity.name}</h1>
                    <span style={{ fontSize: 12, color: theme.tag, fontWeight: 500 }}>{COMMUNITY_THEMES[activeCommunity.themeIdx].label} community</span>
                  </div>
                </div>
              </div>
              <button onClick={() => navigate('/chat?workspace=true')} style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', color: '#000', border: 'none', padding: '10px 18px', borderRadius: 12, fontWeight: 600, fontSize: 14, cursor: 'pointer', transition: 'transform 0.2s' }}
                onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.04)'}
                onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
              ><MessageSquare size={16} /> Chat with Community</button>
            </div>

            <div style={{ background: theme.accent, border: `1px solid ${theme.border}`, backdropFilter: 'blur(32px) saturate(200%)', WebkitBackdropFilter: 'blur(32px) saturate(200%)', borderRadius: 24, padding: 28, display: 'flex', flexDirection: 'column', gap: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}>
              <div style={{ display: 'flex', gap: 8, borderBottom: `1px solid ${theme.border}`, paddingBottom: 14 }}>
                {(['files', 'members'] as const).map(t => (
                  <button key={t} onClick={() => setTab(t)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 500, background: tab === t ? theme.border : 'transparent', color: tab === t ? '#fff' : 'rgba(255,255,255,0.45)', transition: 'background 0.2s, color 0.2s' }}>
                    {t === 'files' ? <FolderOpen size={15} /> : <Users size={15} />}
                    {t === 'files' ? `Files (${activeCommunity.files.length})` : `Members (${activeCommunity.members.length})`}
                  </button>
                ))}
              </div>

              {tab === 'files' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, animation: 'fadeIn 0.25s ease' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '28px', borderRadius: 14, border: `1px dashed ${theme.border}`, cursor: 'pointer', background: 'rgba(0,0,0,0.15)', transition: 'background 0.2s' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'rgba(0,0,0,0.15)'}
                  >
                    <UploadCloud size={28} color={theme.tag} style={{ marginBottom: 10 }} />
                    <span style={{ color: '#fff', fontWeight: 500, fontSize: 14 }}>Upload Files</span>
                    <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 4 }}>PDF, DOCX, CSV, XLSX, PPTX…</span>
                    <input type="file" multiple style={{ display: 'none' }} onChange={handleFileUpload} />
                  </label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {activeCommunity.files.map(f => (
                      <div key={f.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderRadius: 12, background: 'rgba(0,0,0,0.18)', border: `1px solid ${theme.border}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <FileText size={17} color={theme.tag} />
                          <div>
                            <div style={{ color: '#fff', fontSize: 14, fontWeight: 500 }}>{f.name}</div>
                            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 2 }}>{f.size} · {f.date}</div>
                          </div>
                        </div>
                        <button onClick={() => removeFile(f.id)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.35)', cursor: 'pointer', padding: 6, borderRadius: 6, transition: 'color 0.2s' }}
                          onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                          onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.35)'}
                        ><Trash2 size={15} /></button>
                      </div>
                    ))}
                    {activeCommunity.files.length === 0 && <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.35)', padding: '20px 0', fontSize: 14 }}>No files yet.</div>}
                  </div>
                </div>
              )}

              {tab === 'members' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, animation: 'fadeIn 0.25s ease' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13 }}>Manage access for your community.</span>
                    <button style={{ display: 'flex', alignItems: 'center', gap: 6, background: theme.border, color: '#fff', border: 'none', padding: '7px 13px', borderRadius: 8, fontSize: 13, cursor: 'pointer' }}><UserPlus size={14} /> Invite</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {activeCommunity.members.map(m => (
                      <div key={m.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderRadius: 12, background: 'rgba(0,0,0,0.18)', border: `1px solid ${theme.border}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                          <div style={{ width: 36, height: 36, borderRadius: '50%', background: theme.accent, border: `1px solid ${theme.border}`, display: 'grid', placeItems: 'center', color: theme.tag, fontSize: 14, fontWeight: 700 }}>{m.name.charAt(0)}</div>
                          <div>
                            <div style={{ color: '#fff', fontSize: 14, fontWeight: 500 }}>{m.name}</div>
                            <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, marginTop: 2 }}>{m.email}</div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div style={{ position: 'relative' }}>
                            <select value={m.role} onChange={e => updateRole(m.id, e.target.value as Member['role'])} style={{ appearance: 'none', background: 'rgba(0,0,0,0.3)', border: `1px solid ${theme.border}`, color: '#fff', padding: '6px 28px 6px 12px', borderRadius: 6, fontSize: 13, cursor: 'pointer', outline: 'none' }}>
                              <option value="Admin">Admin</option>
                              <option value="Editor">Editor</option>
                              <option value="Viewer">Viewer</option>
                            </select>
                            <Shield size={11} color={theme.tag} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
                          </div>
                          <button onClick={() => removeMember(m.id)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', padding: 5, borderRadius: 6, transition: 'color 0.2s' }}
                            onMouseEnter={e => e.currentTarget.style.color = '#f87171'}
                            onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.3)'}
                          ><Trash2 size={15} /></button>
                        </div>
                      </div>
                    ))}
                    {activeCommunity.members.length === 0 && <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.35)', padding: '20px 0', fontSize: 14 }}>No members yet. Invite someone!</div>}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
      <style>{`@keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:translateY(0); } }`}</style>
    </div>
  );
}
