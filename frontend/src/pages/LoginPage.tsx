import React from 'react';
import { ArrowLeft, Mail, FileText } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4';

export default function LoginPage() {
  const navigate = useNavigate();
  const [isAuthenticating, setIsAuthenticating] = React.useState<string | null>(null);

  const handleOAuth = (provider: string) => {
    setIsAuthenticating(provider);
    setTimeout(() => navigate('/chat'), 1500);
  };

  return (
    <div className="page-shell" style={{ background: '#000' }}>
      {/* Video background */}
      <video className="page-video-bg" autoPlay muted loop playsInline>
        <source src={VIDEO_URL} type="video/mp4" />
      </video>
      {/* Dark scrim */}
      <div className="page-video-scrim" />

      {/* Back link */}
      <Link
        to="/"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'rgba(255,255,255,0.5)',
          fontSize: 13,
          textDecoration: 'none',
          padding: '20px 24px',
          transition: 'color 0.2s',
          zIndex: 2,
          position: 'relative',
          opacity: isAuthenticating ? 0.4 : 1,
          pointerEvents: isAuthenticating ? 'none' : 'auto',
        }}
        onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
        onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.5)')}
      >
        <ArrowLeft size={14} /> Back to Home
      </Link>

      {/* Center card */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          position: 'relative',
          zIndex: 2,
        }}
      >
        <div style={{ width: '100%', maxWidth: 400 }}>
          {/* Logo + title */}
          <div
            className="anim"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              marginBottom: 28,
              ['--d' as string]: '0.05s',
            }}
          >
            <div
              style={{
                width: 54,
                height: 54,
                borderRadius: '50%',
                background: '#fff',
                display: 'grid',
                placeItems: 'center',
                color: '#000',
                marginBottom: 16,
                boxShadow:
                  '0 0 0 1px rgba(255,255,255,0.12), 0 0 32px rgba(255,255,255,0.18)',
              }}
            >
              <FileText size={22} />
            </div>
            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 'clamp(22px, 4vw, 30px)',
                letterSpacing: '-0.04em',
                color: '#fff',
                textAlign: 'center',
              }}
            >
              Welcome to Birbal
            </h1>
            <p
              style={{
                fontSize: 14,
                color: 'var(--muted)',
                textAlign: 'center',
                marginTop: 6,
                lineHeight: 1.55,
              }}
            >
              Sign in to unlock intelligent document intelligence.
            </p>
          </div>

          {/* Frosted glass card */}
          <div
            className="anim"
            style={{
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(255,255,255,0.16)',
              backdropFilter: 'blur(32px) saturate(200%)',
              WebkitBackdropFilter: 'blur(32px) saturate(200%)',
              borderRadius: 28,
              padding: '28px 26px',
              position: 'relative',
              overflow: 'hidden',
              boxShadow:
                '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.12)',
              ['--d' as string]: '0.15s',
            }}
          >
            {/* Top shimmer edge */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 32,
                right: 32,
                height: 1,
                background:
                  'linear-gradient(to right, transparent, rgba(255,255,255,0.3), transparent)',
              }}
            />

            {/* Google */}
            <OAuthBtn
              onClick={() => handleOAuth('google')}
              disabled={!!isAuthenticating}
              loading={isAuthenticating === 'google'}
              loadingText="Connecting to Google…"
              label="Continue with Google"
            >
              <svg width="17" height="17" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
            </OAuthBtn>

            {/* GitHub */}
            <OAuthBtn
              onClick={() => handleOAuth('github')}
              disabled={!!isAuthenticating}
              loading={isAuthenticating === 'github'}
              loadingText="Connecting to GitHub…"
              label="Continue with GitHub"
            >
              <svg width="17" height="17" fill="currentColor" viewBox="0 0 24 24">
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
            </OAuthBtn>

            {/* Divider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0' }}>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>or</span>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.1)' }} />
            </div>

            {/* Email — primary */}
            <OAuthBtn
              onClick={() => handleOAuth('email')}
              disabled={!!isAuthenticating}
              loading={isAuthenticating === 'email'}
              loadingText="Sending magic link…"
              label="Continue with Email"
              primary
            >
              <Mail size={16} />
            </OAuthBtn>

            <p
              style={{
                marginTop: 20,
                textAlign: 'center',
                fontSize: 12,
                color: 'var(--muted)',
                lineHeight: 1.6,
              }}
            >
              By continuing you agree to our{' '}
              <a href="#" style={{ color: 'rgba(255,255,255,0.5)', textDecoration: 'underline', textUnderlineOffset: 2 }}>Terms</a>
              {' '}and{' '}
              <a href="#" style={{ color: 'rgba(255,255,255,0.5)', textDecoration: 'underline', textUnderlineOffset: 2 }}>Privacy Policy</a>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── OAuth Button ── */
function OAuthBtn({
  onClick,
  disabled,
  loading,
  loadingText,
  label,
  primary = false,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  loading: boolean;
  loadingText: string;
  label: string;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        padding: '13px 16px',
        borderRadius: 14,
        background: primary ? '#fff' : 'rgba(255,255,255,0.07)',
        border: `1px solid ${primary ? '#fff' : 'rgba(255,255,255,0.14)'}`,
        backdropFilter: 'blur(8px)',
        color: primary ? '#111' : '#fff',
        fontFamily: 'var(--font-sans)',
        fontSize: 14,
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
        marginBottom: 10,
        opacity: disabled ? 0.55 : 1,
        transition: 'background 0.2s, transform 0.15s, box-shadow 0.2s',
        boxShadow: primary
          ? '0 0 0 1px rgba(255,255,255,0.15), 0 0 18px rgba(255,255,255,0.1)'
          : 'none',
      }}
      onMouseEnter={e => {
        if (!disabled) {
          (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)';
          (e.currentTarget as HTMLButtonElement).style.background = primary
            ? 'rgba(255,255,255,0.9)'
            : 'rgba(255,255,255,0.11)';
        }
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLButtonElement).style.transform = 'none';
        (e.currentTarget as HTMLButtonElement).style.background = primary ? '#fff' : 'rgba(255,255,255,0.07)';
      }}
    >
      {loading ? <Spinner dark={primary} /> : children}
      {loading ? loadingText : label}
    </button>
  );
}

function Spinner({ dark = false }: { dark?: boolean }) {
  return (
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: '50%',
        border: `2px solid ${dark ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.2)'}`,
        borderTopColor: dark ? '#111' : '#fff',
        display: 'inline-block',
        animation: 'spin 0.7s linear infinite',
      }}
    />
  );
}
