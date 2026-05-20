// viewport.jsx — Simulated IDE viewport per agent
// Renders a VS-Code-ish editor with syntax-colored code,
// a blinking caret that drifts as the agent "types".

const LANG_TOKENS = {
  typescript: {
    keyword: ['const', 'let', 'async', 'await', 'function', 'return', 'if', 'else', 'import', 'from', 'export', 'new', 'try', 'catch', 'throw'],
    type: ['string', 'number', 'boolean', 'void', 'Promise', 'Request', 'Response', 'Token'],
  },
  go: {
    keyword: ['func', 'package', 'import', 'return', 'if', 'else', 'for', 'range', 'defer', 'go', 'struct', 'type', 'var'],
    type: ['string', 'int', 'error', 'bool', 'context', 'http'],
  },
  python: {
    keyword: ['def', 'async', 'await', 'return', 'if', 'else', 'elif', 'import', 'from', 'try', 'except', 'with', 'as', 'class'],
    type: ['int', 'str', 'list', 'dict', 'bool', 'None'],
  },
  sql: {
    keyword: ['SELECT', 'FROM', 'WHERE', 'JOIN', 'ON', 'CREATE', 'TABLE', 'ALTER', 'ADD', 'COLUMN', 'INDEX', 'BEGIN', 'COMMIT', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET'],
    type: ['INT', 'TEXT', 'VARCHAR', 'TIMESTAMP', 'BOOLEAN', 'UUID', 'PRIMARY', 'KEY', 'NOT', 'NULL'],
  },
};

// Per-agent code snippets (each line: array of [text, kind] or plain string)
const CODE_SNIPPETS = {
  'auth.ts': [
    "export async function refreshToken(",
    "  session: Session,",
    "): Promise<Token> {",
    "  const res = await fetch(OAUTH_URL, {",
    "    method: 'POST',",
    "    body: encode({",
    "      grant_type: 'refresh_token',",
    "      refresh_token: session.refresh,",
    "    }),",
    "  });",
    "  if (!res.ok) throw new AuthError();",
    "  return res.json();",
    "}",
  ],
  'migrate.sql': [
    "-- 2026_05_19_add_workspace_quota",
    "BEGIN;",
    "",
    "ALTER TABLE workspace",
    "  ADD COLUMN quota_bytes BIGINT",
    "    NOT NULL DEFAULT 10737418240;",
    "",
    "CREATE INDEX idx_ws_quota",
    "  ON workspace (quota_bytes);",
    "",
    "-- backfill from legacy plans table",
    "UPDATE workspace w",
    "   SET quota_bytes = p.bytes",
    "  FROM plans p",
    " WHERE p.tier = w.tier;",
    "",
    "COMMIT;",
  ],
  'handlers.go': [
    "package api",
    "",
    "func (s *Server) handleSync(",
    "  w http.ResponseWriter,",
    "  r *http.Request,",
    ") {",
    "  ctx := r.Context()",
    "  uid, err := s.auth(ctx, r)",
    "  if err != nil {",
    "    writeErr(w, 401, err)",
    "    return",
    "  }",
    "  defer s.metric.Done(uid)",
    "  s.queue.Push(ctx, uid)",
    "}",
  ],
  'utils.spec.ts': [
    "import { describe, it, expect } from 'vitest';",
    "import { chunk, debounce } from './utils';",
    "",
    "describe('chunk', () => {",
    "  it('splits evenly', () => {",
    "    expect(chunk([1,2,3,4], 2))",
    "      .toEqual([[1,2],[3,4]]);",
    "  });",
    "  it('handles remainder', () => {",
    "    expect(chunk([1,2,3], 2))",
    "      .toEqual([[1,2],[3]]);",
    "  });",
    "});",
    "",
    "// ✓ 14 passed  ·  0 failed",
  ],
  'pool.py': [
    "async def acquire(self) -> Conn:",
    "    deadline = time() + self.timeout",
    "    while True:",
    "        if self._free:",
    "            return self._free.pop()",
    "        if self._n < self.max_size:",
    "            self._n += 1",
    "            return await self._dial()",
    "        if time() > deadline:",
    "            raise PoolExhausted(",
    "                f'waited {self.timeout}s',",
    "            )",
    "        await self._cond.wait()",
  ],
};

function tokenize(line, lang) {
  const spec = LANG_TOKENS[lang] || LANG_TOKENS.typescript;
  const out = [];
  // very lightweight tokenizer: split on word/non-word, classify
  const re = /(\s+|'[^']*'|"[^"]*"|\/\/.*$|--.*$|#.*$|\d+|\w+|[^\w\s])/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const t = m[0];
    let kind = 'plain';
    if (/^['"`].*['"`]$/.test(t)) kind = 'string';
    else if (/^(\/\/|--|#)/.test(t)) kind = 'comment';
    else if (/^\d+$/.test(t)) kind = 'number';
    else if (spec.keyword.includes(t)) kind = 'keyword';
    else if (spec.type.includes(t)) kind = 'type';
    else if (/^[A-Z][A-Za-z0-9_]*$/.test(t)) kind = 'type';
    else if (/^[a-z_][\w]*$/.test(t) && line[re.lastIndex] === '(') kind = 'fn';
    out.push([t, kind]);
  }
  return out;
}

const TOKEN_COLORS_DARK = {
  plain: '#cdd6e0',
  keyword: '#c084fc',
  type: '#7dd3fc',
  fn: '#fde68a',
  string: '#86efac',
  number: '#fda4af',
  comment: '#5b6472',
};
const TOKEN_COLORS_LIGHT = {
  plain: '#1f2328',
  keyword: '#8250df',
  type: '#0550ae',
  fn: '#953800',
  string: '#0a7a4a',
  number: '#cf222e',
  comment: '#6a737d',
};

function Viewport({ agent, dark, accent, typingProgress }) {
  const snippet = CODE_SNIPPETS[agent.file] || CODE_SNIPPETS['auth.ts'];
  const colors = dark ? TOKEN_COLORS_DARK : TOKEN_COLORS_LIGHT;

  // chrome colors
  const chrome = dark ? {
    bg: '#0d1117',
    panel: '#161b22',
    sidebar: '#0d1117',
    border: '#21262d',
    text: '#c9d1d9',
    dim: '#7d8590',
    activeTab: '#0d1117',
    inactiveTab: '#010409',
  } : {
    bg: '#ffffff',
    panel: '#f6f8fa',
    sidebar: '#ffffff',
    border: '#d0d7de',
    text: '#1f2328',
    dim: '#656d76',
    activeTab: '#ffffff',
    inactiveTab: '#f6f8fa',
  };

  // how many lines + chars are "typed" so far
  const totalChars = snippet.reduce((a, l) => a + l.length + 1, 0);
  const cursorChar = Math.floor(totalChars * typingProgress);
  let charsLeft = cursorChar;
  let cursorLine = 0;
  let cursorCol = 0;
  for (let i = 0; i < snippet.length; i++) {
    if (charsLeft <= snippet[i].length) {
      cursorLine = i;
      cursorCol = charsLeft;
      break;
    }
    charsLeft -= snippet[i].length + 1;
  }

  // Files in sidebar (fake tree)
  const files = [
    { name: 'src', dir: true, open: true },
    { name: 'auth.ts', file: true, active: agent.file === 'auth.ts' },
    { name: 'handlers.go', file: true, active: agent.file === 'handlers.go' },
    { name: 'pool.py', file: true, active: agent.file === 'pool.py' },
    { name: 'utils.spec.ts', file: true, active: agent.file === 'utils.spec.ts' },
    { name: 'migrations', dir: true, open: false },
  ];

  return (
    <div style={{
      width: '100%',
      height: '100%',
      background: chrome.bg,
      borderRadius: 12,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      boxShadow: dark
        ? '0 0 0 1px rgba(255,255,255,0.04), 0 20px 40px rgba(0,0,0,0.4)'
        : '0 0 0 1px rgba(0,0,0,0.08), 0 20px 40px rgba(0,0,0,0.12)',
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 9,
      position: 'relative',
    }}>
      {/* macOS-style window chrome */}
      <div style={{
        height: 22,
        background: chrome.panel,
        borderBottom: `1px solid ${chrome.border}`,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        gap: 6,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff5f57' }} />
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#febc2e' }} />
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#28c840' }} />
        </div>
        <div style={{
          flex: 1,
          textAlign: 'center',
          color: chrome.dim,
          fontSize: 9,
          fontFamily: "'IBM Plex Sans', sans-serif",
          letterSpacing: 0.2,
        }}>
          {agent.repo} — {agent.file}
        </div>
        <span style={{ width: 38 }} />
      </div>

      {/* tab strip */}
      <div style={{
        height: 24,
        background: chrome.inactiveTab,
        borderBottom: `1px solid ${chrome.border}`,
        display: 'flex',
        alignItems: 'stretch',
        flexShrink: 0,
      }}>
        <div style={{
          background: chrome.activeTab,
          padding: '0 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          color: chrome.text,
          borderRight: `1px solid ${chrome.border}`,
          fontSize: 9,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: accent }} />
          {agent.file}
          <span style={{ color: chrome.dim, marginLeft: 2 }}>·</span>
        </div>
        <div style={{ flex: 1 }} />
      </div>

      {/* body: sidebar + editor */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* sidebar */}
        <div style={{
          width: 84,
          background: chrome.sidebar,
          borderRight: `1px solid ${chrome.border}`,
          padding: '6px 4px',
          flexShrink: 0,
          fontSize: 8.5,
          color: chrome.dim,
          overflow: 'hidden',
        }}>
          <div style={{
            fontSize: 7.5,
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            padding: '0 4px 4px',
            color: chrome.dim,
            fontFamily: "'IBM Plex Sans', sans-serif",
            fontWeight: 600,
          }}>Explorer</div>
          {files.map((f, i) => (
            <div key={i} style={{
              padding: '1.5px 4px',
              paddingLeft: f.file ? 14 : 4,
              borderRadius: 3,
              background: f.active ? (dark ? 'rgba(125,211,252,0.08)' : 'rgba(125,211,252,0.18)') : 'transparent',
              color: f.active ? chrome.text : chrome.dim,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}>
              <span style={{ fontSize: 8 }}>{f.dir ? (f.open ? '▾' : '▸') : ''}</span>
              <span>{f.name}</span>
            </div>
          ))}
        </div>

        {/* editor */}
        <div style={{
          flex: 1,
          background: chrome.bg,
          padding: '4px 0 4px 0',
          overflow: 'hidden',
          position: 'relative',
        }}>
          {snippet.map((line, i) => {
            const tokens = tokenize(line, agent.lang);
            const isCursor = i === cursorLine;
            return (
              <div key={i} style={{
                display: 'flex',
                alignItems: 'flex-start',
                lineHeight: '12px',
                fontSize: 9,
              }}>
                <span style={{
                  width: 22,
                  textAlign: 'right',
                  paddingRight: 6,
                  color: chrome.dim,
                  flexShrink: 0,
                  userSelect: 'none',
                }}>{i + 1}</span>
                <span style={{
                  flex: 1,
                  color: colors.plain,
                  whiteSpace: 'pre',
                  position: 'relative',
                  background: isCursor ? (dark ? 'rgba(125,211,252,0.04)' : 'rgba(9,80,174,0.04)') : 'transparent',
                  paddingLeft: 2,
                }}>
                  {tokens.map(([t, kind], j) => (
                    <span key={j} style={{ color: colors[kind] || colors.plain }}>{t}</span>
                  ))}
                  {isCursor && (
                    <span style={{
                      position: 'absolute',
                      left: 2 + cursorCol * 5.4,
                      top: 1,
                      width: 1.5,
                      height: 10,
                      background: accent,
                      animation: 'caretBlink 1s steps(2) infinite',
                    }} />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* status bar */}
      <div style={{
        height: 16,
        background: accent,
        color: dark ? '#0a0c10' : '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 8px',
        fontSize: 8,
        fontFamily: "'IBM Plex Sans', sans-serif",
        fontWeight: 500,
        flexShrink: 0,
        letterSpacing: 0.2,
      }}>
        <span>● {agent.branch}</span>
        <span>{agent.lang} · UTF-8 · Ln {cursorLine + 1}, Col {cursorCol + 1}</span>
      </div>

      <style>{`
        @keyframes caretBlink { 50% { opacity: 0; } }
      `}</style>
    </div>
  );
}

Object.assign(window, { Viewport });
