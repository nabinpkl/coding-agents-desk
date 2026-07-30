/**
 * Host-free fixture for the WKWebView bridge.
 *
 * Every visibility watch echoes its generated subscription ID. This keeps the
 * fixture on the same replacement-snapshot contract as the native host.
 */

type Source = "claude" | "codex";

const PROJECT_PATH = "/Users/dev/projects/agent-desk";

export const FIXTURE_PROJECTS = [
  {
    pp: PROJECT_PATH,
    dn: "AgentDesk",
    sc: { cl: 1, co: 1 },
    sn: 2,
    lea: Date.now() - 60_000,
  },
  {
    pp: "/Users/dev/projects/research-tool",
    dn: "Research Tool",
    sc: { cl: 0, co: 2 },
    sn: 2,
    lea: Date.now() - 900_000,
  },
];

export const FIXTURE_SESSIONS = [
  {
    sid: "session-claude-001",
    src: "claude" as const,
    ttl: "Implement webview Vite bundle",
    lea: Date.now() - 60_000,
    ac: "live" as const,
  },
  {
    sid: "session-codex-001",
    src: "codex" as const,
    ttl: "Fix TypeScript errors in BridgeDataSource",
    lea: Date.now() - 300_000,
    ac: "ready" as const,
  },
];

type Mode = "raw" | "nice";

/**
 * The thread's lines in file order, tagged with whether the nice view keeps them.
 *
 * One list, both views derived from it, because that is how the sidecar works: the
 * nice view is this list filtered and renumbered, and every index the panel receives
 * is counted in the view it asked for. A fixture that hardcoded two lists could
 * disagree with itself about which line index 4 is, which is exactly the failure the
 * real index has to avoid.
 */
interface FixtureLine {
  /** Present when the nice view omits this line. */
  machinery?: true;
  age: number;
  tp: "user" | "assistant" | "reasoning" | "system";
  b: Array<Record<string, unknown>>;
}

const FIXTURE_LINES: FixtureLine[] = [
  {
    age: 200_000,
    tp: "user",
    b: [
      {
        k: "text",
        tx: "Please implement the webview Vite bundle for the iPhone surface.",
      },
    ],
  },
  {
    age: 195_000,
    tp: "assistant",
    b: [
      { k: "text", tx: "I’ll set up the Vite toolchain and create the webview app." },
      { k: "tool_use", tl: "Write", ci: "call-001", sm: "vite.webview.config.ts" },
    ],
  },
  // Harness state dumps, which is what the nice view exists to drop. Together they
  // are 42% of a real Claude transcript and 26% of a Codex one; the fixture had
  // none, so the only host-free surface for judging this panel could not show what
  // the mode toggle does.
  {
    machinery: true,
    age: 194_000,
    tp: "system",
    b: [
      { k: "metadata", lb: "Token Usage", tx: "41,220 / 200,000 tokens" },
      { k: "raw" },
    ],
  },
  {
    machinery: true,
    age: 193_000,
    tp: "system",
    b: [
      // `Hook`, not `Attachment`: the adapter labels these by subtype now, which is
      // what made 978 diagnostics rows findable among 4,891 hook dumps.
      {
        k: "metadata",
        lb: "Hook",
        tx: '{"exitCode":0,"stdout":"","hookName":"PostToolUse"}',
      },
      { k: "raw" },
    ],
  },
  // A shell call carrying the state metadata the adapters append to nearly every
  // assistant line. Exercises the Raw drawer and the command code block: the summary
  // is deliberately wider than a phone row, and `input` is absent here exactly as
  // the iOS wire delivers it.
  {
    age: 190_000,
    tp: "assistant",
    b: [
      {
        k: "tool_use",
        tl: "Bash",
        ci: "call-002",
        sm: 'ls && echo "---TASKS---" && ls tasks 2>/dev/null | head -30 && git log --oneline --decorate | head -40',
      },
      { k: "metadata", lb: "Token Usage", tx: "68,272 tokens" },
      { k: "metadata", lb: "Stop Reason", tx: "tool_use" },
      { k: "metadata", lb: "Working Directory", tx: PROJECT_PATH },
      { k: "raw" },
    ],
  },
  // Claude delivers a tool result as its own user line, again with the appended
  // metadata. It pairs into the call above rather than taking a row of its own.
  {
    age: 188_000,
    tp: "user",
    b: [
      {
        k: "tool_result",
        ci: "call-002",
        pv: "AGENTS.md\nPRD.md\nSPEC.md\n---TASKS---\n2026-07-18-v12-complete-jsonl-activity-feed.md",
      },
      { k: "metadata", lb: "Working Directory", tx: PROJECT_PATH },
      { k: "raw" },
    ],
  },
  // A run of tool work with nothing between it, which is what the nice view folds
  // into one row. Tool calls and their output are 54 of every 100 rows in this
  // project's largest Codex session, and a fixture without a run of them could not
  // show what clustering does.
  {
    age: 186_000,
    tp: "assistant",
    b: [{ k: "tool_use", tl: "Read", ci: "call-003", sm: "Read AgentPanelApp.tsx" }],
  },
  {
    age: 185_000,
    tp: "user",
    b: [{ k: "tool_result", ci: "call-003", pv: "export function App() {" }],
  },
  {
    age: 184_000,
    tp: "assistant",
    b: [{ k: "tool_use", tl: "Edit", ci: "call-004", sm: "Edit AgentPanelApp.tsx" }],
  },
  {
    age: 183_000,
    tp: "user",
    b: [{ k: "tool_result", ci: "call-004", pv: "applied" }],
  },
  {
    age: 182_000,
    tp: "assistant",
    b: [{ k: "tool_use", tl: "Read", ci: "call-005", sm: "Read fixture.ts" }],
  },
  // A skill activation inside the run, which never folds: it changes what the agent
  // is doing, and hiding it would hide the line that explains the next twenty.
  {
    age: 181_000,
    tp: "assistant",
    b: [{ k: "tool_use", tl: "Skill", ci: "call-006", sm: "Skill codebase-onboarding" }],
  },
  {
    age: 180_000,
    tp: "assistant",
    b: [{ k: "tool_use", tl: "Grep", ci: "call-007", sm: 'pattern "buildFeedLayout"' }],
  },
  {
    age: 179_000,
    tp: "assistant",
    b: [{ k: "tool_use", tl: "Bash", ci: "call-008", sm: "just check" }],
  },
  {
    machinery: true,
    age: 150_000,
    tp: "system",
    b: [
      { k: "metadata", lb: "Mode", tx: '{"mode":"acceptEdits"}' },
      { k: "raw" },
    ],
  },
  // Context compaction, carrying the same appended metadata.
  {
    age: 120_000,
    tp: "system",
    b: [
      { k: "compaction" },
      { k: "metadata", lb: "Working Directory", tx: PROJECT_PATH },
      { k: "raw" },
    ],
  },
  // A reasoning trace, with the bolded topic line these routinely open with. The
  // fixture had no reasoning event at all, which is how reasoning came to be the one
  // content kind rendered as raw text.
  {
    age: 100_000,
    tp: "reasoning",
    b: [
      {
        k: "reasoning",
        tx: "**Adjusting skip parameter handling**\n\nThe offset is clamped before paging, so a negative `beforeIndex` can never reach the reader.",
      },
    ],
  },
];

/**
 * Renumber the fixture lines for one view, the way the sidecar's two indices do.
 *
 * Raw keeps every line and reports each one's nice index (null for machinery); nice
 * keeps only content and reports each one's raw index. Both derived from the single
 * list above, so the fixture cannot disagree with itself about which line an index
 * names -- which is exactly the failure the real index has to avoid.
 */
function fixtureEvents(mode: Mode) {
  const now = Date.now();
  let niceIndex = 0;
  const rows = FIXTURE_LINES.map((line, rawIndex) => ({
    line,
    rawIndex,
    niceIndex: line.machinery ? null : niceIndex++,
  }));
  return rows
    .filter(({ line }) => mode === "raw" || !line.machinery)
    .map(({ line, rawIndex, niceIndex: nice }) => ({
      i: mode === "raw" ? rawIndex : nice!,
      xi: mode === "raw" ? nice : rawIndex,
      ts: now - line.age,
      tp: line.tp,
      b: line.b,
    }));
}

function makeFixtureSeedChunk(source: Source, sessionId: string, mode: Mode) {
  const events = fixtureEvents(mode);
  return {
    t: "agent-thread-chunk",
    src: source,
    sid: sessionId,
    md: mode,
    ev: events,
    ws: 0,
    // One past the seed, because a live chunk follows.
    tot: events.length + 1,
    lv: false,
    // Occupancy on the seed. Claude publishes no window in the transcript, so the
    // sidecar resolves it; this is the resolved shape the panel actually sees.
    u: { cur: 68_272, lim: 200_000, ua: Date.now() - 190_000, mdl: "claude-opus-5" },
  };
}

function makeFixtureLiveChunk(source: Source, sessionId: string, mode: Mode) {
  // Appended after the seed, so its index is counted in the requested view exactly as
  // the sidecar's live subscriber counts it.
  const seedCount = fixtureEvents(mode).length;
  const rawCount = FIXTURE_LINES.length;
  return {
    t: "agent-thread-chunk",
    src: source,
    sid: sessionId,
    md: mode,
    ev: [
      {
        i: seedCount,
        xi: mode === "raw" ? seedCount - (rawCount - seedCount) : rawCount,
        ts: Date.now(),
        tp: "assistant" as const,
        b: [
          {
            k: "text" as const,
            tx: "The layered webview contract is connected.",
          },
        ],
      },
    ],
    ws: seedCount,
    tot: seedCount + 1,
    lv: true,
    // A later, larger reading on the live chunk, so the fixture exercises the
    // thing the whole stage is for: the meter moving without a reload.
    u: { cur: 152_940, lim: 200_000, ua: Date.now(), mdl: "claude-opus-5" },
  };
}

const FIXTURE_RAW_LINE = JSON.stringify({
  type: "assistant",
  cwd: "/Users/dev/projects/agent-desk",
  message: {
    stop_reason: "tool_use",
    usage: { input_tokens: 68_272, output_tokens: 412 },
    content: [{ type: "tool_use", id: "call-002", name: "Bash" }],
  },
});

export function installFixture(): void {
  (window as Window & {
    webkit: {
      messageHandlers: {
        agentFeed: { postMessage: (message: unknown) => void };
      };
    };
  }).webkit = {
    messageHandlers: {
      agentFeed: {
        postMessage: (message: unknown) => {
          const value = message as {
            t?: string;
            sub?: string;
            pp?: string;
            src?: Source;
            sid?: string;
            rid?: string;
            ei?: number;
            md?: Mode;
          };
          switch (value.t) {
            case "agent-projects-watch":
              if (!value.sub) return;
              setTimeout(() => {
                window.__agentFeedDeliver?.({
                  t: "agent-projects",
                  sub: value.sub,
                  p: FIXTURE_PROJECTS,
                });
              }, 30);
              break;
            case "agent-project-sessions-watch":
              if (!value.sub || !value.pp) return;
              setTimeout(() => {
                window.__agentFeedDeliver?.({
                  t: "agent-project-sessions",
                  sub: value.sub,
                  pp: value.pp,
                  ss: value.pp === PROJECT_PATH ? FIXTURE_SESSIONS : [],
                });
              }, 30);
              break;
            case "agent-thread-sub": {
              if (!value.src || !value.sid) return;
              // Absent means raw, the same rule this field follows at every real
              // boundary it crosses.
              const mode: Mode = value.md === "nice" ? "nice" : "raw";
              setTimeout(() => {
                window.__agentFeedDeliver?.(
                  makeFixtureSeedChunk(value.src!, value.sid!, mode),
                );
                setTimeout(() => {
                  window.__agentFeedDeliver?.(
                    makeFixtureLiveChunk(value.src!, value.sid!, mode),
                  );
                }, 80);
              }, 40);
              break;
            }
            case "agent-raw-event-get":
              if (!value.rid || !value.src || !value.sid) return;
              setTimeout(() => {
                window.__agentFeedDeliver?.({
                  t: "agent-raw-event",
                  rid: value.rid,
                  src: value.src,
                  sid: value.sid,
                  ei: value.ei ?? 0,
                  tx: FIXTURE_RAW_LINE,
                });
              }, 30);
              break;
          }
        },
      },
    },
  };
}
