import { useEffect, useRef } from 'react';

/**
 * AnimatedBackground — smooth, continuous Canvas2D dot-grid.
 *
 * Fixes:
 *  - No JS intro animation (was causing double-mount re-sweeps in React StrictMode)
 *  - Proper Perlin noise (permutation table) — no chunky integer-boundary jumps
 *  - Always-running rAF loop — no pause/resume that caused gaps
 *  - CSS opacity fade-in so first frame appears cleanly
 *  - scale=1.5 baked in
 */
export default function AnimatedBackground({ className = '' }) {
  const canvasRef = useRef(null);
  const wrapRef   = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap   = wrapRef.current;
    if (!canvas || !wrap) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // ── Perlin permutation table (generated once) ────────────
    const perm = new Uint8Array(512);
    const seed = new Uint8Array(256);
    for (let i = 0; i < 256; i++) seed[i] = i;
    for (let i = 255; i > 0; i--) {          // Fisher-Yates shuffle
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = seed[i]; seed[i] = seed[j]; seed[j] = tmp;
    }
    for (let i = 0; i < 512; i++) perm[i] = seed[i & 255];

    const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
    const lerp = (a, b, t) => a + (b - a) * t;

    // 2-D gradient Perlin noise, returns value in roughly [-1, 1]
    const grad2 = (h, x, y) => {
      const g = h & 3;
      const u = g < 2 ? x : y;
      const v = g < 2 ? y : x;
      return ((g & 1) ? -u : u) + ((g & 2) ? -v : v);
    };

    const perlin2 = (x, y) => {
      const X = Math.floor(x) & 255;
      const Y = Math.floor(y) & 255;
      const xf = x - Math.floor(x);
      const yf = y - Math.floor(y);
      const u = fade(xf), v = fade(yf);
      const aa = perm[perm[X]     + Y];
      const ab = perm[perm[X]     + Y + 1];
      const ba = perm[perm[X + 1] + Y];
      const bb = perm[perm[X + 1] + Y + 1];
      return lerp(
        lerp(grad2(aa, xf,   yf),   grad2(ba, xf-1,  yf),   u),
        lerp(grad2(ab, xf,   yf-1), grad2(bb, xf-1,  yf-1), u),
        v
      );
    };

    // 2-octave fBm, returns value in [0, 1]
    const noise = (x, y) => {
      const n = perlin2(x, y) * 0.667 + perlin2(x * 2, y * 2) * 0.333;
      return Math.min(1, Math.max(0, n * 0.5 + 0.5));
    };

    // ── Config ───────────────────────────────────────────────
    const CELL      = 22;          // cell pitch in CSS px
    const DOT_FRAC  = 0.42;        // max dot size as fraction of half-cell
    const SCALE     = 1.5;         // noise field scale (user requested)
    const SPEED     = 0.028;       // noise time increment per second
    const SPLASH_R  = 5;           // ripple radius in cells
    const SPLASH_S  = 0.7;
    const W_FRIC    = 0.87;
    const W_SPD     = 0.3;
    const W_DEC     = 0.96;
    const SETTLED   = 0.007;
    const SIM_DT    = 1 / 60;
    const BG        = '#000000';
    const DOT_RGB   = [52, 52, 52];
    const HIT_RGB   = [160, 160, 160];

    // ── State ────────────────────────────────────────────────
    let w = 1, h = 1, cols = 1, rows = 1;
    let charges = new Float32Array(1);
    let heights = new Float32Array(1);
    let prevH   = new Float32Array(1);
    let simBack = 0;
    let waveLive = false;
    let t    = 0;
    let last = 0;
    let raf  = 0;
    let alive = true;

    // ── Pointer ──────────────────────────────────────────────
    const ptr = { x: -9999, y: -9999, px: -9999, py: -9999, at: 0 };

    // ── Grid resize ──────────────────────────────────────────
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth  || 1;
      h = canvas.clientHeight || 1;
      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / CELL) + 1;
      rows = Math.ceil(h / CELL) + 1;
      charges = new Float32Array(cols * rows);
      heights = new Float32Array(cols * rows);
      prevH   = new Float32Array(cols * rows);
      waveLive = false;
    };

    // ── Wave simulation ──────────────────────────────────────
    const splash = (px, py, str) => {
      const cx = px / CELL, cy = py / CELL;
      const r2  = SPLASH_R * SPLASH_R;
      const sig = (SPLASH_R * 0.4) * (SPLASH_R * 0.4) * 2;
      const r0  = Math.max(0, Math.floor(cy - SPLASH_R));
      const r1  = Math.min(rows - 1, Math.ceil(cy + SPLASH_R));
      const c0  = Math.max(0, Math.floor(cx - SPLASH_R));
      const c1  = Math.min(cols - 1, Math.ceil(cx + SPLASH_R));
      for (let r = r0; r <= r1; r++) {
        const dy = r - cy;
        for (let c = c0; c <= c1; c++) {
          const dx = c - cx;
          if (dx*dx + dy*dy > r2) continue;
          heights[r*cols+c] = Math.min(1.3, heights[r*cols+c] + str * Math.exp(-(dx*dx+dy*dy)/sig));
        }
      }
      waveLive = true;
    };

    const stepWave = () => {
      const lc = cols - 1, lr = rows - 1;
      let peak = 0;
      for (let r = 0; r < rows; r++) {
        const up   = (r === 0  ? 0 : r-1) * cols;
        const dn   = (r === lr ? r : r+1) * cols;
        const base = r * cols;
        for (let c = 0; c < cols; c++) {
          const i  = base + c;
          const l  = base + (c === 0  ? 0 : c-1);
          const ri = base + (c === lc ? c : c+1);
          const H  = heights[i];
          const lap = heights[l] + heights[ri] + heights[up+c] + heights[dn+c] - 4*H;
          const vel = (H - prevH[i]) * W_FRIC;
          const nxt = (H + vel + W_SPD * lap) * W_DEC;
          prevH[i]   = nxt;
          charges[i] = Math.min(1, Math.max(0, nxt));
          if (charges[i] > peak) peak = charges[i];
        }
      }
      const tmp = heights; heights = prevH; prevH = tmp;
      return peak;
    };

    const tickWave = (dt) => {
      if (!waveLive) return;
      simBack = Math.min(simBack + dt, SIM_DT * 4);
      let peak = 1;
      while (simBack >= SIM_DT) { simBack -= SIM_DT; peak = stepWave(); }
      if (peak < SETTLED) {
        heights.fill(0); prevH.fill(0); charges.fill(0); waveLive = false;
      }
    };

    // ── Render ───────────────────────────────────────────────
    // Noise coords: 1 cell = CELL px, scaled by SCALE
    // So noise repeats over (256 * CELL * SCALE) ≈ 8448 px — huge, seamless
    const NSCALE = 1 / (CELL * 5 * SCALE);
    const half   = CELL * 0.5;
    const maxR   = half * DOT_FRAC;

    const render = (now) => {
      raf = 0;
      if (!alive) return;

      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      t += dt * SPEED;

      tickWave(dt);

      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, w, h);

      for (let r = 0; r < rows; r++) {
        const cy = r * CELL + half;
        for (let c = 0; c < cols; c++) {
          const cx = c * CELL + half;

          // smooth perlin noise → [0,1]
          const tone = noise(cx * NSCALE, cy * NSCALE + t);
          // contrast-stretch so all 3 bands are equally likely
          const stretched = Math.min(0.9999, Math.max(0, (tone - 0.15) / 0.70));
          const band3 = Math.floor(stretched * 3);

          const charge = charges[r*cols+c] || 0;
          const stepped = (band3 + Math.floor(Math.min(0.999, charge) * 3)) % 3;
          // 0=small circle, 1=square, 2=large circle (no heavy triangle calc for perf)
          // Use: 0=circle-small, 1=square, 2=triangle  — all three shapes
          const shape  = stepped;                          // 0, 1, 2
          const radius = maxR * (0.38 + 0.62 * (stepped / 2));

          // color
          const mix = Math.min(1, charge * 2.5);
          const cr = (DOT_RGB[0] + (HIT_RGB[0]-DOT_RGB[0]) * mix) | 0;
          const cg = (DOT_RGB[1] + (HIT_RGB[1]-DOT_RGB[1]) * mix) | 0;
          const cb = (DOT_RGB[2] + (HIT_RGB[2]-DOT_RGB[2]) * mix) | 0;

          ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
          ctx.beginPath();

          if (shape === 0) {
            ctx.arc(cx, cy, radius, 0, 6.2832);
            ctx.fill();
          } else if (shape === 1) {
            const s = radius * 1.3;
            ctx.rect(cx - s, cy - s, s * 2, s * 2);
            ctx.fill();
          } else {
            const s = radius * 1.55;
            ctx.moveTo(cx,             cy - s);
            ctx.lineTo(cx + s * 0.866, cy + s * 0.5);
            ctx.lineTo(cx - s * 0.866, cy + s * 0.5);
            ctx.closePath();
            ctx.fill();
          }
        }
      }

      raf = requestAnimationFrame(render);
    };

    // ── Pointer handler ──────────────────────────────────────
    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const now = performance.now();
      const elapsed = Math.max(8, now - ptr.at);
      const dist = Math.hypot(x - ptr.px, y - ptr.py);
      splash(x, y, Math.min(1, 0.22 + (dist/elapsed)*0.7) * SPLASH_S);
      ptr.px = ptr.x; ptr.py = ptr.y;
      ptr.x = x; ptr.y = y; ptr.at = now;
    };

    // ── Init ─────────────────────────────────────────────────
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    // CSS fade-in — avoids the "first frame flash" without a JS intro sweep
    requestAnimationFrame(() => {
      canvas.style.opacity = '1';
    });

    last = 0;
    raf = requestAnimationFrame(render);
    window.addEventListener('pointermove', onMove, { passive: true });

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('pointermove', onMove);
    };
  }, []);   // empty deps — run exactly once (StrictMode safe via `alive` flag)

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <canvas
        ref={canvasRef}
        className={className}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          opacity: 0,                                    // CSS fade-in
          transition: 'opacity 0.8s ease',
        }}
        aria-hidden="true"
      />
    </div>
  );
}
