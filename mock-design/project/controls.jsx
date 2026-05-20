// controls.jsx — Mac-style trackpad (multi-touch) + compact keyboard.

const { useState, useRef, useEffect, useCallback } = React;

// ─────────────────────────────────────────────────────────────
// Trackpad — Mac-style with multi-touch gestures:
//   • 1-finger drag      → move cursor
//   • 1-finger tap       → left-click
//   • 1-finger double-tap → double-click
//   • 2-finger tap       → right-click
//   • 2-finger drag      → scroll
// ─────────────────────────────────────────────────────────────
function Trackpad({ dark, accent, sensitivity = 1, haptics = true, onCursorMove, onClick, onScroll }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ x: 50, y: 50 });
  const [active, setActive] = useState(false);
  const [gesture, setGesture] = useState(null); // 'move' | 'scroll' | 'right'
  const [scrollY, setScrollY] = useState(0);
  const startPts = useRef(null);
  const lastPts = useRef(null);
  const startTime = useRef(0);
  const lastTap = useRef(0);
  const moved = useRef(false);

  const buzz = useCallback((ms) => {
    if (haptics && navigator.vibrate) navigator.vibrate(ms);
  }, [haptics]);

  const ptsFromTouches = (e) => {
    if (e.touches) {
      return Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }));
    }
    return [{ x: e.clientX, y: e.clientY }];
  };

  const handleStart = (e) => {
    const pts = ptsFromTouches(e);
    startPts.current = pts;
    lastPts.current = pts;
    startTime.current = Date.now();
    moved.current = false;
    setActive(true);
    setGesture(pts.length >= 2 ? 'scroll' : 'move');
  };

  const handleMove = (e) => {
    if (!startPts.current || !ref.current) return;
    const pts = ptsFromTouches(e);
    if (!lastPts.current || pts.length === 0) return;
    const last = lastPts.current;
    const dx = (pts[0].x - last[0].x) * sensitivity;
    const dy = (pts[0].y - last[0].y) * sensitivity;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved.current = true;
    const rect = ref.current.getBoundingClientRect();

    if (pts.length >= 2) {
      // 2-finger scroll
      setGesture('scroll');
      setScrollY(s => s + dy * 0.6);
      onScroll?.(dy);
      // haptic detents every ~22px of scroll
      if (Math.abs(dy) > 1) {
        const detent = Math.floor((scrollY + dy) / 22);
        const prev = Math.floor(scrollY / 22);
        if (detent !== prev) buzz(3);
      }
    } else {
      // cursor move
      setGesture('move');
      setPos(p => {
        const nx = Math.max(2, Math.min(98, p.x + (dx / rect.width) * 100));
        const ny = Math.max(2, Math.min(98, p.y + (dy / rect.height) * 100));
        onCursorMove?.({ x: nx, y: ny });
        return { x: nx, y: ny };
      });
    }
    lastPts.current = pts;
    if (e.cancelable) e.preventDefault?.();
  };

  const handleEnd = (e) => {
    if (!startPts.current) return;
    const dur = Date.now() - startTime.current;
    const fingerCount = startPts.current.length;
    if (dur < 220 && !moved.current) {
      // tap
      if (fingerCount >= 2) {
        onClick?.('right');
        buzz(12);
      } else {
        const now = Date.now();
        if (now - lastTap.current < 320) {
          onClick?.('double');
          buzz([6, 30, 6]);
        } else {
          onClick?.('left');
          buzz(6);
        }
        lastTap.current = now;
      }
    }
    startPts.current = null;
    lastPts.current = null;
    setActive(false);
    setTimeout(() => setGesture(null), 250);
  };

  const pad = dark ? {
    bg: '#15191f',
    bg2: '#11151b',
    border: '#252b34',
    grid: 'rgba(255,255,255,0.05)',
    label: 'rgba(255,255,255,0.32)',
    labelStrong: 'rgba(255,255,255,0.55)',
  } : {
    bg: '#edeff3',
    bg2: '#e6e9ee',
    border: '#d4d8e0',
    grid: 'rgba(0,0,0,0.04)',
    label: 'rgba(0,0,0,0.38)',
    labelStrong: 'rgba(0,0,0,0.62)',
  };

  return (
    <div
      ref={ref}
      onTouchStart={handleStart}
      onTouchMove={handleMove}
      onTouchEnd={handleEnd}
      onMouseDown={handleStart}
      onMouseMove={(e) => startPts.current && handleMove(e)}
      onMouseUp={handleEnd}
      onMouseLeave={(e) => startPts.current && handleEnd(e)}
      style={{
        width: '100%',
        height: '100%',
        background: `linear-gradient(180deg, ${pad.bg} 0%, ${pad.bg2} 100%)`,
        border: `1px solid ${pad.border}`,
        borderRadius: 18,
        position: 'relative',
        overflow: 'hidden',
        touchAction: 'none',
        userSelect: 'none',
        cursor: 'crosshair',
        boxShadow: active
          ? `inset 0 0 0 1.5px ${accent}55, 0 0 0 4px ${accent}10`
          : 'inset 0 1px 0 rgba(255,255,255,0.04), 0 1px 0 rgba(255,255,255,0.02)',
        transition: 'box-shadow 0.18s ease',
      }}
    >
      {/* dot grid */}
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <defs>
          <pattern id="dotgrid" width="14" height="14" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.7" fill={pad.label} opacity="0.4" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#dotgrid)" />
      </svg>

      {/* header label */}
      <div style={{
        position: 'absolute',
        top: 10,
        insetInlineStart: 12,
        fontSize: 8.5,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        fontWeight: 600,
        fontFamily: "'IBM Plex Mono', monospace",
        color: pad.label,
      }}>Trackpad</div>

      <div style={{
        position: 'absolute',
        top: 10,
        insetInlineEnd: 12,
        fontSize: 8.5,
        letterSpacing: 0.4,
        fontFamily: "'IBM Plex Mono', monospace",
        color: gesture ? pad.labelStrong : pad.label,
        transition: 'color 0.15s ease',
      }}>
        {gesture === 'scroll' ? '⇅ SCROLL' : gesture === 'right' ? 'RIGHT' : `${Math.round(pos.x)},${Math.round(pos.y)}`}
      </div>

      {/* gesture hints — bottom */}
      <div style={{
        position: 'absolute',
        bottom: 10,
        insetInlineStart: 12,
        insetInlineEnd: 12,
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: 8,
        fontFamily: "'IBM Plex Mono', monospace",
        color: pad.label,
        letterSpacing: 0.4,
        pointerEvents: 'none',
      }}>
        <span>tap · drag</span>
        <span>two-finger · scroll / right-click</span>
      </div>

      {/* tracked cursor preview */}
      <div style={{
        position: 'absolute',
        insetInlineStart: `calc(${pos.x}% - 7px)`,
        top: `calc(${pos.y}% - 7px)`,
        width: 14,
        height: 14,
        pointerEvents: 'none',
      }}>
        <div style={{
          position: 'absolute',
          inset: active && gesture === 'move' ? -5 : 0,
          borderRadius: '50%',
          background: accent,
          opacity: 0.18,
          transition: 'inset 0.18s ease',
        }} />
        <div style={{
          position: 'absolute',
          inset: 4,
          borderRadius: '50%',
          background: accent,
          boxShadow: `0 0 0 1px ${dark ? '#0a0c10' : '#fff'}`,
        }} />
      </div>

      {/* scroll indicator (right edge) */}
      {gesture === 'scroll' && (
        <div style={{
          position: 'absolute',
          insetInlineEnd: 6,
          top: '50%',
          marginTop: -32,
          width: 3,
          height: 64,
          borderRadius: 2,
          background: accent,
          opacity: 0.85,
          boxShadow: `0 0 8px ${accent}`,
          animation: 'pulse 0.6s ease-in-out infinite',
        }} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Compact keyboard — minimalist, fits in the control area.
// Sends key events upward via onKey.
// ─────────────────────────────────────────────────────────────
const KB_ROWS = [
  ['q','w','e','r','t','y','u','i','o','p'],
  ['a','s','d','f','g','h','j','k','l'],
  ['z','x','c','v','b','n','m'],
];

function CompactKeyboard({ dark, accent, haptics = true, onKey }) {
  const [shift, setShift] = useState(false);
  const [layer, setLayer] = useState('letters'); // 'letters' | 'numbers'
  const [pressed, setPressed] = useState(null);

  const buzz = () => { if (haptics && navigator.vibrate) navigator.vibrate(4); };

  const c = dark ? {
    bg: '#15191f',
    bg2: '#11151b',
    border: '#252b34',
    keyBg: 'rgba(255,255,255,0.06)',
    keyBgPress: 'rgba(255,255,255,0.14)',
    keyText: '#e8eaed',
    label: 'rgba(255,255,255,0.5)',
    chrome: '#0f1318',
  } : {
    bg: '#edeff3',
    bg2: '#e6e9ee',
    border: '#d4d8e0',
    keyBg: 'rgba(0,0,0,0.04)',
    keyBgPress: 'rgba(0,0,0,0.1)',
    keyText: '#1a1d23',
    label: 'rgba(0,0,0,0.55)',
    chrome: '#ffffff',
  };

  const numRows = [
    ['1','2','3','4','5','6','7','8','9','0'],
    ['-','/',':',';','(',')','$','&','@','"'],
    ['.',',','?','!','\''],
  ];
  const rows = layer === 'numbers' ? numRows : KB_ROWS;

  const handlePress = (k) => {
    buzz();
    setPressed(k);
    setTimeout(() => setPressed(null), 100);
    if (k === '__shift') { setShift(s => !s); return; }
    if (k === '__num') { setLayer('numbers'); return; }
    if (k === '__abc') { setLayer('letters'); return; }
    if (k === '__symbols2') { return; }
    onKey?.(k);
    if (shift && layer === 'letters') setShift(false);
  };

  const Key = ({ label, k, flex = 1, width, special = false, active = false }) => (
    <button
      onPointerDown={() => handlePress(k)}
      style={{
        flex: width ? undefined : flex,
        width,
        height: 32,
        background: pressed === k ? c.keyBgPress : (active ? accent : c.keyBg),
        border: `1px solid ${c.border}`,
        borderRadius: 6,
        color: active ? (dark ? '#0a0c10' : '#fff') : c.keyText,
        fontSize: special ? 10 : 14,
        fontWeight: special ? 600 : 500,
        fontFamily: special ? "'IBM Plex Mono', monospace" : "'IBM Plex Sans', sans-serif",
        letterSpacing: special ? 0.5 : 0,
        cursor: 'pointer',
        padding: 0,
        transition: 'background 0.08s, opacity 0.08s',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)',
        textTransform: special ? 'uppercase' : 'none',
      }}
    >{label}</button>
  );

  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: `linear-gradient(180deg, ${c.bg} 0%, ${c.bg2} 100%)`,
      border: `1px solid ${c.border}`,
      borderRadius: 18,
      padding: '10px 8px 8px',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
    }}>
      {/* target line — shows where typing goes */}
      <div style={{
        background: c.chrome,
        borderRadius: 6,
        padding: '5px 9px',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10,
        color: c.label,
        marginBottom: 3,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
      }}>
        <span style={{ color: accent, fontWeight: 600 }}>›</span>
        <span style={{ flex: 1 }}>Sending keys to remote</span>
        <span style={{ fontSize: 8.5, letterSpacing: 0.4 }}>EN</span>
      </div>

      {/* rows */}
      {rows.map((row, ri) => (
        <div key={ri} style={{
          display: 'flex',
          gap: 4,
          paddingInlineStart: ri === 1 && layer === 'letters' ? 14 : 0,
          paddingInlineEnd: ri === 1 && layer === 'letters' ? 14 : 0,
        }}>
          {ri === 2 && layer === 'letters' && (
            <Key label="⇧" k="__shift" width={36} special active={shift} />
          )}
          {ri === 2 && layer !== 'letters' && (
            <Key label="#+=" k="__symbols2" width={36} special />
          )}
          {row.map(letter => (
            <Key
              key={letter}
              label={shift && layer === 'letters' ? letter.toUpperCase() : letter}
              k={shift && layer === 'letters' ? letter.toUpperCase() : letter}
            />
          ))}
          {ri === 2 && (
            <Key label="⌫" k="__bksp" width={36} special />
          )}
        </div>
      ))}

      {/* bottom row */}
      <div style={{ display: 'flex', gap: 4 }}>
        <Key
          label={layer === 'letters' ? '123' : 'ABC'}
          k={layer === 'letters' ? '__num' : '__abc'}
          width={48}
          special
        />
        <Key label="␣" k=" " flex={5} special />
        <Key label="⏎" k="__return" width={56} special active />
      </div>
    </div>
  );
}

// expose
Object.assign(window, { Trackpad, CompactKeyboard });
