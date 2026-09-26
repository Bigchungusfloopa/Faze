import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import LogoLoop from '../LogoLoop';
import './landing.css';

const FILE_TYPES = [
  { node: <span style={{ fontWeight: 700, fontSize: '18px', letterSpacing: '1px', color: '#fff' }}>PDF</span> },
  { node: <span style={{ fontWeight: 700, fontSize: '18px', letterSpacing: '1px', color: '#fff' }}>DOCX</span> },
  { node: <span style={{ fontWeight: 700, fontSize: '18px', letterSpacing: '1px', color: '#fff' }}>CSV</span> },
  { node: <span style={{ fontWeight: 700, fontSize: '18px', letterSpacing: '1px', color: '#fff' }}>XLSX</span> },
  { node: <span style={{ fontWeight: 700, fontSize: '18px', letterSpacing: '1px', color: '#fff' }}>PPTX</span> },
  { node: <span style={{ fontWeight: 700, fontSize: '18px', letterSpacing: '1px', color: '#fff' }}>TXT</span> },
  { node: <span style={{ fontWeight: 700, fontSize: '18px', letterSpacing: '1px', color: '#fff' }}>MD</span> },
  { node: <span style={{ fontWeight: 700, fontSize: '18px', letterSpacing: '1px', color: '#fff' }}>JSON</span> },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    // Add class to body to enforce black background and overflow hidden
    document.body.classList.add('landing-active');

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const counters = document.querySelectorAll('.stat-val');
            counters.forEach((counter, i) => {
              const targetStr = counter.getAttribute('data-target') || '0';
              const target = parseFloat(targetStr);
              const suffix = counter.getAttribute('data-suffix') || '';
              const prefix = counter.getAttribute('data-prefix') || '';
              const decimals = parseInt(counter.getAttribute('data-decimals') || '0', 10);
              const duration = 1500 + i * 80;
              const delay = 480 + i * 90;

              let startTimestamp: number | null = null;
              
              setTimeout(() => {
                const step = (timestamp: number) => {
                  if (!startTimestamp) startTimestamp = timestamp;
                  const progress = Math.min((timestamp - startTimestamp) / duration, 1);
                  // easeOutCubic
                  const easeProgress = 1 - Math.pow(1 - progress, 3);
                  const current = (easeProgress * target).toFixed(decimals);
                  
                  if (counter) {
                    counter.innerHTML = `${prefix}${current}${suffix}`;
                  }

                  if (progress < 1) {
                    window.requestAnimationFrame(step);
                  } else if (counter) {
                    counter.innerHTML = `${prefix}${target.toFixed(decimals)}${suffix}`;
                  }
                };
                window.requestAnimationFrame(step);
              }, delay);
            });
            observer.disconnect();
          }
        });
      },
      { threshold: 0.25 }
    );

    const statsSection = document.querySelector('.stats-footer');
    if (statsSection) {
      observer.observe(statsSection);
    }

    return () => {
      document.body.classList.remove('landing-active');
      observer.disconnect();
    };
  }, []);

  const toggleMenu = () => {
    setIsMenuOpen(!isMenuOpen);
  };

  return (
    <div className={`landing-page ${isMenuOpen ? 'menu-open' : ''}`}>
      <video className="bg-video" autoPlay muted loop playsInline>
        <source
          src="https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260809_012548_ef22562c-c0ae-4816-ad9d-f8922af4e6a7.mp4"
          type="video/mp4"
        />
      </video>

      {/* Desktop Header */}
      <header className="landing-header">
        <a href="#" className="landing-logo">
          <FileText size={24} />
        </a>
        <nav className="nav-pill">
          <Link to="/" className="nav-link active">Home</Link>
          <Link to="/workspace" className="nav-link">Workspace</Link>
          <Link to="/chat" className="nav-link">Chat</Link>
        </nav>
        <button onClick={() => navigate('/login')} className="btn-signin" style={{ border: 'none', cursor: 'pointer' }}>
          Sign in
        </button>
      </header>

      {/* Mobile Header */}
      <header className="mobile-header">
        <a href="#" className="mobile-logo">
          <FileText size={24} />
        </a>
        <button className="burger" onClick={toggleMenu} aria-expanded={isMenuOpen}>
          <div className="bar"></div>
          <div className="bar"></div>
          <div className="bar"></div>
        </button>
      </header>

      {/* Mobile Menu Overlay */}
      <div className="mobile-overlay" onClick={toggleMenu}></div>
      <div className="mobile-sheet">
        <Link to="/" className="mobile-link active" onClick={toggleMenu}>Home</Link>
        <Link to="/workspace" className="mobile-link" onClick={toggleMenu}>Workspace</Link>
        <Link to="/chat" className="mobile-link" onClick={toggleMenu}>Chat</Link>
        <button onClick={() => { toggleMenu(); navigate('/login'); }} className="mobile-signin" style={{ border: 'none', cursor: 'pointer' }}>
          Sign in
        </button>
      </div>

      <main className="hero-section">
        <div className="trust-row anim" style={{ '--d': '0.05s' } as React.CSSProperties}>
          <div className="trust-avatar">
            <div className="trust-inner"><i className="fa-solid fa-file-pdf"></i></div>
          </div>
          <div className="trust-avatar">
            <div className="trust-inner"><i className="fa-solid fa-file-excel"></i></div>
          </div>
          <div className="trust-avatar">
            <div className="trust-inner"><i className="fa-solid fa-file-csv"></i></div>
          </div>
        </div>

        <h1 className="headline">
          <span>Document</span>
          <span>Intelligence</span>
        </h1>

        <p className="subhead anim" style={{ '--d': '0.28s' } as React.CSSProperties}>
          Automated classification and NLP extraction. Extract insights from your documents in seconds.
        </p>

        <button 
          onClick={() => navigate('/chat')} 
          className="cta-btn anim-pulse" 
          style={{ '--d': '0.4s', border: 'none', cursor: 'pointer' } as React.CSSProperties}
        >
          Get Started
        </button>
      </main>

      <footer className="stats-footer">
        <div className="stat-box anim" style={{ '--d': '0.58s' } as React.CSSProperties}>
          <div className="stat-icon">%</div>
          <div className="stat-val" data-target="99.2" data-suffix="%" data-decimals="1">0.0%</div>
          <div className="stat-label">OCR Accuracy</div>
        </div>
        <div className="stat-box anim" style={{ '--d': '0.66s' } as React.CSSProperties}>
          <div className="stat-icon">+</div>
          <div className="stat-val" data-target="20" data-suffix="+" data-decimals="0">0+</div>
          <div className="stat-label">Document Formats</div>
        </div>
      </footer>

      <div 
        className="anim" 
        style={{ 
          '--d': '0.75s', 
          marginTop: 'auto', 
          marginBottom: '40px', 
          width: '90%', 
          maxWidth: '600px',
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
          backdropFilter: 'blur(16px) saturate(180%)',
          borderRadius: '999px',
          padding: '16px 32px',
          overflow: 'hidden',
          display: 'flex',
          justifyContent: 'center',
          boxShadow: '0 8px 32px rgba(0,0,0,0.2)'
        } as React.CSSProperties}
      >
        <LogoLoop 
          logos={FILE_TYPES} 
          speed={30} 
          gap={50} 
          fadeOut={false} 
          style={{ maskImage: 'linear-gradient(to right, transparent, black 15%, black 85%, transparent)', WebkitMaskImage: 'linear-gradient(to right, transparent, black 15%, black 85%, transparent)' }}
        />
      </div>
    </div>
  );
}
