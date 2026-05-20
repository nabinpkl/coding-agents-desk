// app.jsx — AgentDesk: mobile remote desktop for AI agents.

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ─────────────────────────────────────────────────────────────
// Agents (workspace fleet)
// ─────────────────────────────────────────────────────────────
const ALL_AGENTS = [
  {
    id: 'cypher', name: 'Cypher', glyph: 'Cy',
    status: 'working', host: 'sb-04.us-west',
    task: 'Implementing OAuth refresh',
    file: 'auth.ts', lang: 'typescript', branch: 'feat/oauth-refresh',
    repo: 'core-api',
    reasoning: [
      'Reading existing refresh handler…',
      'Found legacy retry on line 142 — replacing.',
      'Need to encode body as form-urlencoded, not JSON.',
      'Writing test for the refused-token branch.',
    ],
    hue: 210,
  },
  {
    id: 'mira', name: 'Mira', glyph: 'Mi',
    status: 'awaiting', host: 'sb-12.eu-west',
    task: 'Awaiting approval — DB migration',
    file: 'migrate.sql', lang: 'sql', branch: 'ops/quota-column',
    repo: 'infra-db',
    reasoning: [
      'Migration drafted: ALTER TABLE workspace.',
      'Backfill query runs in 4.2s on staging.',
      'Pausing for human sign-off before prod.',
    ],
    hue: 35,
  },
  {
    id: 'atlas', name: 'Atlas', glyph: 'At',
    status: 'working', host: 'sb-07.ap-south',
    task: 'Refactoring HTTP handlers',
    file: 'handlers.go', lang: 'go', branch: 'refactor/handlers',
    repo: 'edge-gw',
    reasoning: [
      'Extracting auth middleware…',
      'Switching to context-scoped logger.',
      'Three handlers updated, four to go.',
    ],
    hue: 145,
  },
  {
    id: 'nova', name: 'Nova', glyph: 'No',
    status: 'idle', host: 'sb-19.us-east',
    task: 'Tests passing — standing by',
    file: 'utils.spec.ts', lang: 'typescript', branch: 'main',
    repo: 'shared-lib',
    reasoning: [
      'All 14 cases green.',
      'Idle for 12m — awaiting next assignment.',
    ],
    hue: 270,
  },
  {
    id: 'echo', name: 'Echo', glyph: 'Ec',
    status: 'working', host: 'sb-22.us-west',
    task: 'Tracing redis pool exhaustion',
    file: 'pool.py', lang: 'python', branch: 'fix/pool-leak',
    repo: 'queue-worker',
    reasoning: [
      'Reproduced exhaustion under load.',
      'Connections held past deadline — bug confirmed.',
      'Drafting cond.wait() with timeout.',
    ],
    hue: 320,
  },
  {
    id: 'orion', name: 'Orion', glyph: 'Or',
    status: 'working', host: 'sb-31.eu-north',
    task: 'Migrating CI to bun',
    file: 'auth.ts', lang: 'typescript', branch: 'ci/bun',
    repo: 'platform',
    reasoning: [
      'Updating workflow yaml…',
      'Bun lockfile committed.',
    ],
    hue: 175,
  },
  {
    id: 'vega', name: 'Vega', glyph: 'Ve',
    status: 'awaiting', host: 'sb-44.us-east',
    task: 'Awaiting credentials — Stripe',
    file: 'handlers.go', lang: 'go', branch: 'feat/billing',
    repo: 'billing',
    reasoning: [
      'Stripe SDK installed.',
      'Asking human for restricted API key…',
    ],
    hue: 95,
  },
];

const ACCENT_PRESETS = [
  { name: 'Teal',   value: 'oklch(0.72 0.13 210)' },
  { name: 'Lime',   value: 'oklch(0.78 0.16 140)' },
  { name: 'Amber',  value: 'oklch(0.78 0.15 75)'  },
  { name: 'Violet', value: 'oklch(0.68 0.17 295)' },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "accent": "oklch(0.72 0.13 210)",
  "sensitivity": 1,
  "haptics": true,
  "agentCount": 5,
  "showReasoning": true
}/*EDITMODE-END*/;

// ─────────────────────────────────────────────────────────────
// Status pill
// ─────────────────────────────────────────────────────────────
function StatusPill({ status, dark, accent }) {
  const map = {
    working:  { label: 'WORKING',  color: accent, dot: true },
    awaiting: { label: 'AWAITING', color: '#fbbf24', dot: true },
    idle:     { label: 'IDLE',     color: dark ? '#6b7280' : '#9ca3af', dot: false },
    error:    { label: 'ERROR',    color: '#ef4444', dot: true },
  };
  const s = map[status] || map.idle;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '4px 9px 4px 8px',
      borderRadius: 999,
      background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
      border: `1px solid ${dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'}`,
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 9,
      fontWeight: 600,
      letterSpacing: 0.8,
      color: s.color,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: s.color,
        boxShadow: s.dot ? `0 0 6px ${s.color}` : 'none',
        animation: s.dot && status === 'working' ? 'pulse 1.6s ease-in-out infinite' : 'none',
      }} />
      {s.label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// Agent avatar — colored gradient tile with initials
// ─────────────────────────────────────────────────────────────
function AgentAvatar({ agent, dark, size = 36 }) {
  return (
    <div style={{
      width: size, height: size,
      borderRadius: size * 0.28,
      background: `linear-gradient(135deg,
        oklch(0.72 0.14 ${agent.hue}),
        oklch(0.55 0.18 ${(agent.hue + 40) % 360}))`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: size * 0.34,
      fontWeight: 600,
      color: dark ? '#0a0c10' : '#fff',
      letterSpacing: 0.4,
      flexShrink: 0,
      boxShadow: `0 4px 12px oklch(0.5 0.14 ${agent.hue} / 0.35), inset 0 1px 0 rgba(255,255,255,0.15)`,
    }}>
      {agent.glyph}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Reasoning ticker — cycles through agent's chain-of-thought
// ─────────────────────────────────────────────────────────────
function ReasoningTicker({ agent, dark }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    setIdx(0);
    if (agent.status !== 'working') return;
    const t = setInterval(() => {
      setIdx(i => (i + 1) % agent.reasoning.length);
    }, 2800);
    return () => clearInterval(t);
  }, [agent.id, agent.status]);
  const line = agent.reasoning[idx] || agent.reasoning[0];
  return (
    <div style={{
      fontSize: 10.5,
      fontFamily: "'IBM Plex Mono', monospace",
      color: dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      letterSpacing: 0.1,
    }} key={`${agent.id}-${idx}`}>
      <span style={{
        display: 'inline-block',
        animation: 'fadeIn 0.4s ease',
      }}>
        <span style={{ opacity: 0.5, marginRight: 6 }}>›</span>
        {line}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Page dots / page indicator
// ─────────────────────────────────────────────────────────────
function PageDots({ count, active, accent, dark, onSelect }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'center',
      gap: 6,
      padding: '6px 0',
    }}>
      {Array.from({ length: count }).map((_, i) => (
        <button
          key={i}
          onClick={() => onSelect(i)}
          style={{
            width: i === active ? 18 : 5,
            height: 5,
            borderRadius: 3,
            background: i === active ? accent : (dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)'),
            transition: 'all 0.25s ease',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
          }}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Toast — small floating message for click/tap feedback
// ─────────────────────────────────────────────────────────────
function Toast({ message, dark, accent }) {
  if (!message) return null;
  return (
    <div style={{
      position: 'absolute',
      bottom: 100,
      left: '50%',
      marginLeft: -90,
      padding: '8px 14px',
      borderRadius: 999,
      background: dark ? 'rgba(20,24,30,0.92)' : 'rgba(255,255,255,0.96)',
      border: `1px solid ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'}`,
      backdropFilter: 'blur(12px)',
      fontSize: 11,
      fontFamily: "'IBM Plex Mono', monospace",
      letterSpacing: 0.3,
      color: dark ? '#e8eaed' : '#1a1d23',
      boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
      zIndex: 30,
      animation: 'toastIn 0.2s ease',
      whiteSpace: 'nowrap',
    }}>
      <span style={{ color: accent, marginRight: 6 }}>●</span>
      {message}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Mode toggle — segmented control between trackpad and keyboard
// ─────────────────────────────────────────────────────────────
function ModeToggle({ mode, onChange, dark, accent }) {
  const opts = [
    { value: 'trackpad', label: 'Trackpad', icon: (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="0.75" y="2.25" width="10.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.1"/>
        <circle cx="6" cy="6" r="1" fill="currentColor"/>
      </svg>
    )},
    { value: 'keyboard', label: 'Keyboard', icon: (
      <svg width="14" height="12" viewBox="0 0 14 12" fill="none">
        <rect x="0.75" y="2.25" width="12.5" height="7.5" rx="1.2" stroke="currentColor" strokeWidth="1.1"/>
        <rect x="2.5" y="4" width="1" height="1" fill="currentColor"/>
        <rect x="4.5" y="4" width="1" height="1" fill="currentColor"/>
        <rect x="6.5" y="4" width="1" height="1" fill="currentColor"/>
        <rect x="8.5" y="4" width="1" height="1" fill="currentColor"/>
        <rect x="10.5" y="4" width="1" height="1" fill="currentColor"/>
        <rect x="3.5" y="7" width="7" height="1" fill="currentColor"/>
      </svg>
    )},
  ];

  const c = dark ? {
    bg: 'rgba(255,255,255,0.04)',
    border: 'rgba(255,255,255,0.07)',
    text: 'rgba(255,255,255,0.5)',
    activeText: '#0a0c10',
  } : {
    bg: 'rgba(0,0,0,0.04)',
    border: 'rgba(0,0,0,0.07)',
    text: 'rgba(0,0,0,0.5)',
    activeText: '#ffffff',
  };

  return (
    <div style={{
      display: 'inline-flex',
      background: c.bg,
      border: `1px solid ${c.border}`,
      borderRadius: 999,
      padding: 2,
      gap: 0,
      position: 'relative',
    }}>
      {opts.map(opt => {
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '5px 11px',
              borderRadius: 999,
              border: 'none',
              background: active ? accent : 'transparent',
              color: active ? c.activeText : c.text,
              fontSize: 10.5,
              fontWeight: active ? 600 : 500,
              letterSpacing: 0.2,
              fontFamily: "'IBM Plex Sans', sans-serif",
              cursor: 'pointer',
              transition: 'background 0.18s, color 0.18s',
            }}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main app
// ─────────────────────────────────────────────────────────────
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const dark = t.theme === 'dark';
  const accent = t.accent;
  const agents = ALL_AGENTS.slice(0, t.agentCount);

  const [idx, setIdx] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [typing, setTyping] = useState(0); // 0..1
  const [toast, setToast] = useState(null);
  const [controlMode, setControlMode] = useState('trackpad'); // 'trackpad' | 'keyboard'
  const [typedBuffer, setTypedBuffer] = useState('');
  const dragStart = useRef(null);
  const railWrapRef = useRef(null);
  const [railW, setRailW] = useState(370);

  // measure carousel viewport width for pixel-based translateX
  useEffect(() => {
    if (!railWrapRef.current) return;
    const measure = () => {
      const el = railWrapRef.current;
      const cs = window.getComputedStyle(el);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const padR = parseFloat(cs.paddingRight) || 0;
      setRailW(el.clientWidth - padL - padR);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(railWrapRef.current);
    return () => ro.disconnect();
  }, []);

  // drive scrollLeft from idx + drag (unused — kept noop for resilience)
  useEffect(() => {
    if (!railWrapRef.current) return;
  }, [idx, railW, dragX]);

  // sync body theme
  useEffect(() => {
    document.body.dataset.theme = t.theme;
  }, [t.theme]);

  // clamp idx if agentCount changes
  useEffect(() => {
    if (idx >= agents.length) setIdx(Math.max(0, agents.length - 1));
  }, [agents.length, idx]);

  const agent = agents[idx] || agents[0];

  // typing progress sim
  useEffect(() => {
    setTyping(0);
    if (agent.status !== 'working') {
      setTyping(0.85);
      return;
    }
    let raf;
    let start = Date.now();
    const tick = () => {
      const t = ((Date.now() - start) / 9000) % 1; // 9s loops
      setTyping(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [agent.id, agent.status]);

  // swipe gestures on upper region
  const onSwipeStart = (e) => {
    const t = e.touches ? e.touches[0] : e;
    dragStart.current = { x: t.clientX, y: t.clientY };
  };
  const onSwipeMove = (e) => {
    if (!dragStart.current) return;
    const t = e.touches ? e.touches[0] : e;
    const dx = t.clientX - dragStart.current.x;
    const dy = t.clientY - dragStart.current.y;
    if (Math.abs(dx) > Math.abs(dy)) {
      setDragX(dx);
      if (e.cancelable) e.preventDefault?.();
    }
  };
  const onSwipeEnd = () => {
    if (!dragStart.current) return;
    const dx = dragX;
    if (Math.abs(dx) > 60) {
      if (dx < 0 && idx < agents.length - 1) setIdx(idx + 1);
      else if (dx > 0 && idx > 0) setIdx(idx - 1);
    }
    setDragX(0);
    dragStart.current = null;
  };

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 1200);
  }, []);

  // Colors
  const bg = dark ? '#0a0c10' : '#f4f5f7';
  const surface = dark ? '#0f1318' : '#ffffff';
  const border = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  const text = dark ? '#e8eaed' : '#1a1d23';
  const dim = dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';

  return (
    <div style={{ position: 'relative' }}>
      <IOSDevice dark={dark} width={402} height={874}>
        <div style={{
          position: 'relative',
          height: '100%',
          background: bg,
          color: text,
          paddingTop: 54,
          paddingBottom: 34,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          fontFamily: "'IBM Plex Sans', sans-serif",
          overflow: 'hidden',
        }}>
          {/* ── HEADER ────────────────────────────────────────── */}
          <header style={{
            height: 44,
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
            position: 'relative',
            zIndex: 5,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 20, height: 20,
                borderRadius: 5,
                background: accent,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}>
                <div style={{
                  width: 10, height: 10,
                  borderRadius: 2,
                  background: dark ? '#0a0c10' : '#fff',
                }} />
              </div>
              <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: -0.2 }}>AgentDesk</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                fontSize: 9.5,
                fontFamily: "'IBM Plex Mono', monospace",
                color: dim,
                letterSpacing: 0.4,
              }}>{agents.length} CONNECTED</span>
              <button style={{
                width: 28, height: 28, borderRadius: 8,
                background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
                border: `1px solid ${border}`,
                color: text,
                fontSize: 16,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0,
              }}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="1" y="1" width="4" height="4" rx="0.8" stroke="currentColor" strokeWidth="1.2"/>
                  <rect x="7" y="1" width="4" height="4" rx="0.8" stroke="currentColor" strokeWidth="1.2"/>
                  <rect x="1" y="7" width="4" height="4" rx="0.8" stroke="currentColor" strokeWidth="1.2"/>
                  <rect x="7" y="7" width="4" height="4" rx="0.8" stroke="currentColor" strokeWidth="1.2"/>
                </svg>
              </button>
            </div>
          </header>

          {/* ── SWIPE ZONE (identity + viewport + dots) ────────── */}
          <div
            onTouchStart={onSwipeStart}
            onTouchMove={onSwipeMove}
            onTouchEnd={onSwipeEnd}
            onMouseDown={onSwipeStart}
            onMouseMove={(e) => dragStart.current && onSwipeMove(e)}
            onMouseUp={onSwipeEnd}
            onMouseLeave={() => { if (dragStart.current) { setDragX(0); dragStart.current = null; } }}
            style={{ touchAction: 'pan-y', userSelect: 'none' }}
          >
            {/* identity strip */}
            <div style={{
              padding: '6px 16px 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <AgentAvatar agent={agent} dark={dark} size={40} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 3,
                }}>
                  <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: -0.3 }}>{agent.name}</span>
                  <StatusPill status={agent.status} dark={dark} accent={accent} />
                </div>
                <div style={{
                  fontSize: 10.5,
                  color: dim,
                  fontFamily: "'IBM Plex Mono', monospace",
                  letterSpacing: 0.2,
                }}>
                  {agent.host} · {agent.repo}
                </div>
              </div>
              <button style={{
                width: 32, height: 32, borderRadius: 9,
                background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
                border: `1px solid ${border}`,
                color: text,
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0,
              }}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="3" cy="7" r="1.2" fill="currentColor"/>
                  <circle cx="7" cy="7" r="1.2" fill="currentColor"/>
                  <circle cx="11" cy="7" r="1.2" fill="currentColor"/>
                </svg>
              </button>
            </div>

            {/* viewport — single slide swap on idx change */}
            <div
              ref={railWrapRef}
              style={{
                padding: '0 16px',
                height: 290,
                overflow: 'hidden',
              }}
            >
              <div
                key={agent.id}
                style={{
                  width: '100%',
                  height: '100%',
                  animation: 'slideIn 0.3s ease',
                  opacity: 1 - Math.min(Math.abs(dragX) / 200, 0.4),
                }}
              >
                <Viewport
                  agent={agent}
                  dark={dark}
                  accent={accent}
                  typingProgress={typing}
                />
              </div>
            </div>

            {/* dots */}
            <PageDots
              count={agents.length}
              active={idx}
              accent={accent}
              dark={dark}
              onSelect={setIdx}
            />

            {/* reasoning ticker */}
            {t.showReasoning && (
              <div style={{
                padding: '4px 16px 8px',
                height: 18,
              }}>
                <ReasoningTicker agent={agent} dark={dark} />
              </div>
            )}
          </div>

          {/* ── CONTROLS: mode toggle + trackpad/keyboard ────────── */}
          <div style={{
            flex: 1,
            padding: '8px 16px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            minHeight: 0,
          }}>
            {/* mode toggle */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexShrink: 0,
            }}>
              <div style={{
                fontSize: 9,
                letterSpacing: 1,
                textTransform: 'uppercase',
                fontWeight: 600,
                fontFamily: "'IBM Plex Mono', monospace",
                color: dim,
              }}>
                CONTROL · {controlMode === 'trackpad' ? agent.host : 'keyboard input'}
              </div>
              <ModeToggle
                mode={controlMode}
                onChange={(m) => {
                  setControlMode(m);
                  if (t.haptics && navigator.vibrate) navigator.vibrate(6);
                }}
                dark={dark}
                accent={accent}
              />
            </div>

            {/* surface */}
            <div style={{ flex: 1, minHeight: 0 }}>
              {controlMode === 'trackpad' ? (
                <Trackpad
                  dark={dark}
                  accent={accent}
                  sensitivity={t.sensitivity}
                  haptics={t.haptics}
                  onClick={(kind) => {
                    if (kind === 'double') showToast('Double-click → open');
                    else if (kind === 'right') showToast('Right-click menu');
                    else showToast('Click sent to ' + agent.host);
                  }}
                  onScroll={() => {}}
                />
              ) : (
                <CompactKeyboard
                  dark={dark}
                  accent={accent}
                  haptics={t.haptics}
                  onKey={(k) => {
                    if (k === '__return') {
                      showToast('↩ Sent: ' + (typedBuffer || '(empty)'));
                      setTypedBuffer('');
                    } else if (k === '__bksp') {
                      setTypedBuffer(s => s.slice(0, -1));
                    } else if (k.length === 1) {
                      setTypedBuffer(s => (s + k).slice(-24));
                    }
                  }}
                />
              )}
            </div>
          </div>

          <Toast message={toast} dark={dark} accent={accent} />
        </div>
      </IOSDevice>

      {/* ── TWEAKS PANEL ─────────────────────────────────────── */}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Appearance" />
        <TweakRadio
          label="Theme"
          value={t.theme}
          options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
          onChange={(v) => setTweak('theme', v)}
        />
        <TweakColor
          label="Accent"
          value={t.accent}
          options={ACCENT_PRESETS.map(p => p.value)}
          onChange={(v) => setTweak('accent', v)}
        />
        <TweakSection label="Trackpad" />
        <TweakSlider
          label="Sensitivity"
          value={t.sensitivity}
          min={0.4} max={2.4} step={0.1}
          onChange={(v) => setTweak('sensitivity', v)}
        />
        <TweakToggle
          label="Haptic detents"
          value={t.haptics}
          onChange={(v) => setTweak('haptics', v)}
        />
        <TweakSection label="Fleet" />
        <TweakSlider
          label="Agents in fleet"
          value={t.agentCount}
          min={2} max={ALL_AGENTS.length} step={1}
          onChange={(v) => setTweak('agentCount', v)}
        />
        <TweakToggle
          label="Show reasoning ticker"
          value={t.showReasoning}
          onChange={(v) => setTweak('showReasoning', v)}
        />
      </TweaksPanel>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes toastIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideIn {
          from { opacity: 0.3; }
          to { opacity: 1; }
        }
        .agentdesk-rail::-webkit-scrollbar { display: none; width: 0; height: 0; }
        .agentdesk-rail { -ms-overflow-style: none; }
      `}</style>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
