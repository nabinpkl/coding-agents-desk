// The projects, sessions and transcript lines the fake sidecar answers with.
//
// One set of lines, projected into both modes: raw keeps every line, nice keeps the
// content lines, and each reports its index in the other. Kept apart from the routes
// so a reader changing what the fixture SHOWS never has to read the framing.

import type { ActivityEvent, EventMode, ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";

export const PROJECT_PATH = "/Users/dev/projects/agent-desk";

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
export interface FixtureLine {
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
    blocks: [{ kind: "text", text: "Please implement the webview Vite bundle for the iPhone surface." }],
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
    blocks: [{ kind: "metadata", label: "Token Usage", text: "41,220 / 200,000 tokens" }, { kind: "raw" }],
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
        summary:
          'ls && echo "---TASKS---" && ls tasks 2>/dev/null | head -30 && git log --oneline --decorate | head -40',
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
    blocks: [{ kind: "metadata", label: "Mode", text: '{"mode":"acceptEdits"}' }, { kind: "raw" }],
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
export function fixtureEvents(mode: EventMode): ActivityEvent[] {
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

export const FIXTURE_RAW_LINE = JSON.stringify({
  type: "assistant",
  cwd: PROJECT_PATH,
  message: {
    stop_reason: "tool_use",
    usage: { input_tokens: 68_272, output_tokens: 412 },
    content: [{ type: "tool_use", id: "call-002", name: "Bash" }],
  },
});
