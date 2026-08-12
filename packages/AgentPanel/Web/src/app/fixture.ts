/**
 * A fake sidecar behind the real relay, so the panel can run with no host and no agents.
 *
 * It answers `agent-http-req` frames rather than standing in for the data source, which means
 * fixture mode exercises the whole path the product uses: request correlation, chunk reassembly,
 * subscription framing, and the wire shapes themselves. The previous fixture faked thirteen typed
 * message pairs, so it could and did drift from the host it imitated; there is one envelope to
 * imitate now, and it carries no field of anything the sidecar says.
 */

import type {
  ActivityEvent,
  EventMode,
  ProjectSummary,
  SessionSummary,
  SourceId,
  TimelineMessage,
} from "@agentdesk/agent-feed-wire";

const PROJECT_PATH = "/Users/dev/projects/agent-desk";

export const FIXTURE_PROJECTS: ProjectSummary[] = [
  {
    projectPath: PROJECT_PATH,
    displayName: "AgentDesk",
    sourceCounts: { claude: 1, codex: 1 },
    sessionCount: 2,
    lastEventAt: Date.now() - 60_000,
  },
  {
    projectPath: "/Users/dev/projects/research-tool",
    displayName: "Research Tool",
    sourceCounts: { claude: 0, codex: 2 },
    sessionCount: 2,
    lastEventAt: Date.now() - 900_000,
  },
];

export const FIXTURE_SESSIONS: SessionSummary[] = [
  {
    sessionId: "session-claude-001",
    source: "claude",
    title: "Implement webview Vite bundle",
    lastEventAt: Date.now() - 60_000,
    activity: "live",
    capabilities: {
      modes: ["raw", "nice"],
      canSend: true,
      canSteer: true,
      canAbort: true,
      canFetchRaw: true,
      canOpenTerminal: true,
      supportsExtensionUi: true,
      canStreamLive: true,
    },
  },
  {
    sessionId: "session-codex-001",
    source: "codex",
    title: "Fix TypeScript errors in the panel data source",
    lastEventAt: Date.now() - 300_000,
    activity: "ready",
    capabilities: {
      modes: ["raw", "nice"],
      canSend: true,
      canSteer: true,
      canAbort: true,
      canFetchRaw: true,
      canOpenTerminal: true,
      supportsExtensionUi: false,
      canStreamLive: false,
    },
  },
];

/**
 * The thread's lines in file order, tagged with whether the nice view keeps them.
 *
 * One list, both views derived from it, because that is how the sidecar works: the nice view is
 * this list filtered and renumbered, and every index the panel receives is counted in the view it
 * asked for. A fixture that hardcoded two lists could disagree with itself about which line index
 * 4 is, which is exactly the failure the real index has to avoid.
 */
interface FixtureLine {
  /** Present when the nice view omits this line. */
  machinery?: true;
  age: number;
  type: ActivityEvent["type"];
  blocks: ActivityEvent["blocks"];
}

const FIXTURE_LINES: FixtureLine[] = [
  {
    age: 200_000,
    type: "user",
    blocks: [
      { kind: "text", text: "Please implement the webview Vite bundle for the iPhone surface." },
    ],
  },
  {
    age: 195_000,
    type: "assistant",
    blocks: [
      { kind: "text", text: "I’ll set up the Vite toolchain and create the webview app." },
      { kind: "tool_use", tool: "Write", callId: "call-001", summary: "vite.webview.config.ts" },
    ],
  },
  // Harness state dumps, which is what the nice view exists to drop. Together they are 42% of a
  // real Claude transcript and 26% of a Codex one; the fixture had none, so the only host-free
  // surface for judging this panel could not show what the mode toggle does.
  {
    machinery: true,
    age: 194_000,
    type: "system",
    blocks: [
      { kind: "metadata", label: "Token Usage", text: "41,220 / 200,000 tokens" },
      { kind: "raw" },
    ],
  },
  {
    machinery: true,
    age: 193_000,
    type: "system",
    blocks: [
      // `Hook`, not `Attachment`: the adapter labels these by subtype now, which is what made 978
      // diagnostics rows findable among 4,891 hook dumps.
      {
        kind: "metadata",
        label: "Hook",
        text: '{"exitCode":0,"stdout":"","hookName":"PostToolUse"}',
      },
      { kind: "raw" },
    ],
  },
  // A shell call carrying the state metadata the adapters append to nearly every assistant line.
  // Exercises the Raw drawer and the command code block: the summary is deliberately wider than a
  // phone row, and `input` is absent here exactly as the iOS wire delivers it.
  {
    age: 190_000,
    type: "assistant",
    blocks: [
      {
        kind: "tool_use",
        tool: "Bash",
        callId: "call-002",
        summary: 'ls && echo "---TASKS---" && ls tasks 2>/dev/null | head -30 && git log --oneline --decorate | head -40',
      },
      { kind: "metadata", label: "Token Usage", text: "68,272 tokens" },
      { kind: "metadata", label: "Stop Reason", text: "tool_use" },
      { kind: "metadata", label: "Working Directory", text: PROJECT_PATH },
      { kind: "raw" },
    ],
  },
  // Claude delivers a tool result as its own user line, again with the appended metadata. It pairs
  // into the call above rather than taking a row of its own.
  {
    age: 188_000,
    type: "user",
    blocks: [
      {
        kind: "tool_result",
        callId: "call-002",
        preview: "AGENTS.md\nPRD.md\nSPEC.md\n---TASKS---\n2026-07-18-v12-complete-jsonl-activity-feed.md",
      },
      { kind: "metadata", label: "Working Directory", text: PROJECT_PATH },
      { kind: "raw" },
    ],
  },
  // A run of tool work with nothing between it, which is what the nice view folds into one row.
  // Tool calls and their output are 54 of every 100 rows in this project's largest Codex session,
  // and a fixture without a run of them could not show what clustering does.
  {
    age: 186_000,
    type: "assistant",
    blocks: [{ kind: "tool_use", tool: "Read", callId: "call-003", summary: "Read AgentPanelApp.tsx" }],
  },
  {
    age: 185_000,
    type: "user",
    blocks: [{ kind: "tool_result", callId: "call-003", preview: "export function App() {" }],
  },
  {
    age: 184_000,
    type: "assistant",
    blocks: [{ kind: "tool_use", tool: "Edit", callId: "call-004", summary: "Edit AgentPanelApp.tsx" }],
  },
  {
    age: 183_000,
    type: "user",
    blocks: [{ kind: "tool_result", callId: "call-004", preview: "applied" }],
  },
  {
    age: 182_000,
    type: "assistant",
    blocks: [{ kind: "tool_use", tool: "Read", callId: "call-005", summary: "Read fixture.ts" }],
  },
  // A skill activation inside the run, which never folds: it changes what the agent is doing, and
  // hiding it would hide the line that explains the next twenty.
  {
    age: 181_000,
    type: "assistant",
    blocks: [{ kind: "tool_use", tool: "Skill", callId: "call-006", summary: "Skill codebase-onboarding" }],
  },
  {
    age: 180_000,
    type: "assistant",
    blocks: [{ kind: "tool_use", tool: "Grep", callId: "call-007", summary: 'pattern "buildFeedLayout"' }],
  },
  {
    age: 179_000,
    type: "assistant",
    blocks: [{ kind: "tool_use", tool: "Bash", callId: "call-008", summary: "just check" }],
  },
  {
    machinery: true,
    age: 150_000,
    type: "system",
    blocks: [
      { kind: "metadata", label: "Mode", text: '{"mode":"acceptEdits"}' },
      { kind: "raw" },
    ],
  },
  // Context compaction, carrying the same appended metadata.
  {
    age: 120_000,
    type: "system",
    blocks: [
      { kind: "compaction" },
      { kind: "metadata", label: "Working Directory", text: PROJECT_PATH },
      { kind: "raw" },
    ],
  },
  // An assistant answer with the structure these actually have: a heading, a paragraph under it,
  // and a nested heading. The fixture rendered no heading at all, so the one host-free surface for
  // judging this panel could not show the heading-to-body scale -- which is the thing that goes
  // wrong when the body size moves, because headings are sized in `em` and follow it.
  {
    age: 104_000,
    type: "assistant",
    blocks: [
      {
        kind: "text",
        text: "## To see it\n\nThe running host still has the earlier build, so neither the size nor the leading is in it yet. Both need a rebuild.\n\n### What a pass should confirm\n\nBoth saved windows come back at their remembered frames.",
      },
    ],
  },
  // A reasoning trace, with the bolded topic line these routinely open with. The fixture had no
  // reasoning event at all, which is how reasoning came to be the one content kind rendered as
  // raw text.
  {
    age: 100_000,
    type: "reasoning",
    blocks: [
      {
        kind: "reasoning",
        text: "**Adjusting skip parameter handling**\n\nThe offset is clamped before paging, so a negative `beforeIndex` can never reach the reader.",
      },
    ],
  },
];

/**
 * Renumbers the fixture lines for one view, the way the sidecar's two indices do.
 *
 * Raw keeps every line and reports each one's nice index (null for machinery); nice keeps only
 * content and reports each one's raw index.
 */
function fixtureEvents(mode: EventMode): ActivityEvent[] {
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
      id: `fixture-${rawIndex}`,
      index: mode === "raw" ? rawIndex : nice!,
      otherModeIndex: mode === "raw" ? nice : rawIndex,
      revision: 0,
      phase: "complete" as const,
      ts: now - line.age,
      type: line.type,
      blocks: line.blocks,
    }));
}

const FIXTURE_RAW_LINE = JSON.stringify({
  type: "assistant",
  cwd: PROJECT_PATH,
  message: {
    stop_reason: "tool_use",
    usage: { input_tokens: 68_272, output_tokens: 412 },
    content: [{ type: "tool_use", id: "call-002", name: "Bash" }],
  },
});

// ---------------------------------------------------------------------------
// The fake sidecar
// ---------------------------------------------------------------------------

/** What one request answers with: a status, then zero or more messages, then an end. */
interface FixtureRoute {
  status: number;
  /** Each entry is one complete message: a whole body for a request, one event for a stream. */
  messages: Array<{ delay: number; payload: string }>;
  /** Streams stay open after their scripted messages; one-shot requests end. */
  keepOpen?: boolean;
}

function timeline(mode: EventMode): FixtureRoute {
  const events = fixtureEvents(mode);
  const snapshot: TimelineMessage = {
    type: "timeline",
    envelope: {
      kind: "snapshot",
      sequence: events.length,
      mode,
      events,
      windowStart: 0,
      // One past the seed, because a live chunk follows.
      total: events.length + 1,
      runState: "running",
      queue: { steer: 0, followUp: 0 },
      // Occupancy on the seed. Claude publishes no window in the transcript, so the sidecar
      // resolves it; this is the resolved shape the panel actually sees.
      usage: { current: 68_272, limit: 200_000, updatedAt: Date.now() - 190_000, model: "claude-opus-5" },
    },
  };
  const appended: TimelineMessage = {
    type: "timeline",
    envelope: {
      kind: "upsert",
      sequence: events.length + 1,
      mode,
      events: [
        {
          id: "fixture-live",
          index: events.length,
          otherModeIndex: null,
          revision: 0,
          phase: "complete",
          ts: Date.now(),
          type: "assistant",
          blocks: [{ kind: "text", text: "The layered webview contract is connected." }],
        },
      ],
      windowStart: 0,
      total: events.length + 1,
      runState: "idle",
      queue: { steer: 0, followUp: 0 },
      // A later, larger reading on the appended envelope, so the fixture exercises the thing the
      // whole stage is for: the meter moving without a reload.
      usage: { current: 152_940, limit: 200_000, updatedAt: Date.now(), model: "claude-opus-5" },
    },
  };
  return {
    status: 200,
    keepOpen: true,
    messages: [
      { delay: 40, payload: JSON.stringify(snapshot) },
      { delay: 120, payload: JSON.stringify(appended) },
      ...liveTurn(mode, events.length + 1),
    ],
  };
}

/**
 * A whole streaming turn, then the transcript taking it over.
 *
 * The fixture could show every durable shape and no live one, which left the row a
 * reader actually watches -- the one still arriving -- judgeable only against a real
 * agent. It matters most for exactly the thing this row is built around: the message
 * grows, gains a tool call, completes, and is replaced by its durable self, and none
 * of that may move the paragraph being read.
 *
 * Written as growing whole texts rather than deltas because that is what the mirror
 * publishes: it accumulates into its blocks and republishes the message each time.
 */
function liveTurn(mode: EventMode, sequence: number): Array<{ delay: number; payload: string }> {
  const prose = [
    "Reading the",
    "Reading the failing line. The **replacement** did not match, so",
    "Reading the failing line. The **replacement** did not match, so the file on disk\nstill has its original text.\n\nChecking whether the excerpt strips the leading tab.",
  ];
  const tail = (blocks: ActivityEvent["blocks"], phase: "streaming" | "complete"): TimelineMessage => ({
    type: "tail",
    event: {
      id: "fixture-tail",
      index: -1,
      otherModeIndex: null,
      revision: 0,
      phase,
      ts: Date.now(),
      type: "assistant",
      messageId: "msg_fixture_tail",
      blocks,
    },
  });
  const withTool = [{ kind: "text" as const, text: prose[2]! }, {
    kind: "tool_use" as const,
    tool: "Read",
    summary: "packages/AgentPanel/Web/src/features/activity-feed/ActivityFeed.tsx",
    callId: "fixture-call",
  }];
  // Absolute from the moment the stream opens, not gaps between messages: the
  // fixture arms one timer per message off a single open, so a "delay" read as a
  // gap would fire the end of the turn before its beginning.
  return [
    ...prose.map((text, step) => ({
      delay: 900 + step * 700,
      payload: JSON.stringify(tail([{ kind: "text", text }], "streaming")),
    })),
    { delay: 3_000, payload: JSON.stringify(tail(withTool, "streaming")) },
    { delay: 3_700, payload: JSON.stringify(tail(withTool, "complete")) },
    // The handoff: the same message, now a transcript line. The panel drops the tail
    // on the messageId match, so the two never appear at once.
    {
      delay: 4_400,
      payload: JSON.stringify({
        type: "timeline",
        envelope: {
          kind: "upsert",
          sequence: sequence + 1,
          mode,
          events: [{
            id: "fixture-tail-durable",
            index: sequence,
            otherModeIndex: null,
            revision: 0,
            phase: "complete",
            ts: Date.now(),
            type: "assistant",
            messageId: "msg_fixture_tail",
            blocks: withTool,
          }],
          windowStart: 0,
          total: sequence + 1,
          runState: "idle",
          queue: { steer: 0, followUp: 0 },
        },
      } satisfies TimelineMessage),
    },
  ];
}

/** Resolves one request path to its canned answer, or null for 404. */
function route(method: string, path: string): FixtureRoute | null {
  const [pathname, query = ""] = path.split("?");
  const parameters = new URLSearchParams(query);
  const mode: EventMode = parameters.get("mode") === "nice" ? "nice" : "raw";

  if (pathname === "/api/inventory/stream") {
    // `projectPath`, repeated, because that is what the sidecar's route reads. This
    // fixture stands in for the sidecar, so a name invented here is a name the real
    // route will refuse -- and it will refuse it with a 400 the whole test suite is
    // happy to never see.
    const messages = [
      { delay: 30, payload: JSON.stringify({ projects: FIXTURE_PROJECTS }) },
      ...parameters.getAll("projectPath").map((projectPath) => ({
        delay: 30,
        payload: JSON.stringify({
          projectPath,
          sessions: projectPath === PROJECT_PATH ? FIXTURE_SESSIONS : [],
        }),
      })),
    ];
    return { status: 200, keepOpen: true, messages };
  }
  if (pathname?.endsWith("/timeline")) return timeline(mode);
  if (pathname?.endsWith("/raw")) {
    return { status: 200, messages: [{ delay: 30, payload: FIXTURE_RAW_LINE }] };
  }
  if (method === "POST") {
    // Commands are accepted and do nothing. The fixture has no agent to run them.
    return {
      status: 202,
      messages: [{ delay: 20, payload: JSON.stringify({ requestId: "fixture", delivery: "immediate" }) }],
    };
  }
  return null;
}

/**
 * Installs the fake sidecar as the page's message handler.
 *
 * Must run before the transport is constructed: the transport picks its backend by whether this
 * handler exists.
 */
export function installFixture(): void {
  const open = new Set<string>();

  const deliver = (frame: unknown) => window.__agentFeedDeliver?.(frame);

  const answer = (rid: string, method: string, path: string) => {
    const answered = route(method, path);
    if (!answered) {
      deliver({ t: "agent-http-head", rid, status: 404 });
      deliver({
        t: "agent-http-chunk",
        rid,
        seq: 0,
        data: JSON.stringify({ error: { code: "not-found", message: `no fixture for ${path}` } }),
        complete: true,
      });
      deliver({ t: "agent-http-end", rid });
      return;
    }
    setTimeout(() => {
      if (!open.has(rid)) return;
      deliver({ t: "agent-http-head", rid, status: answered.status });
    }, 10);
    let sequence = 0;
    for (const message of answered.messages) {
      const seq = sequence++;
      setTimeout(() => {
        if (!open.has(rid)) return;
        deliver({ t: "agent-http-chunk", rid, seq, data: message.payload, complete: true });
      }, message.delay);
    }
    if (answered.keepOpen) return;
    const last = answered.messages.at(-1)?.delay ?? 10;
    setTimeout(() => {
      if (!open.delete(rid)) return;
      deliver({ t: "agent-http-end", rid });
    }, last + 5);
  };

  (window as Window & {
    webkit: {
      messageHandlers: { agentFeed: { postMessage: (message: unknown) => void } };
    };
  }).webkit = {
    messageHandlers: {
      agentFeed: {
        postMessage: (message: unknown) => {
          const frame = message as { t?: string; rid?: string; method?: string; path?: string };
          if (!frame.rid) return;
          if (frame.t === "agent-http-cancel") {
            open.delete(frame.rid);
            return;
          }
          if (frame.t !== "agent-http-req" || !frame.path) return;
          open.add(frame.rid);
          answer(frame.rid, frame.method ?? "GET", frame.path);
        },
      },
    },
  };
}
