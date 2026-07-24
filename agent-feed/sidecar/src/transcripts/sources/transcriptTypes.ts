// Canonical, source-agnostic types. The Claude and Codex adapters emit these
// shapes; everything above the adapter (events index, watcher, HTTP/SSE,
// Agent Panel) consumes only these.
//
// The seam: each adapter knows its own JSONL layout and translates one line
// into an optional ActivityEvent plus an optional turn-boundary signal.
// The sidecar owns file watching, byte-cursor tracking, and notification.
//
// Liveness is never stored. A session is 'live' iff its transcript was
// written recently AND the last observed turn is still open; both facts are
// cheap per-line parse outputs, and the bin is derived at read time
// (digest.computeBin). This is what makes a harness that died mid-turn age
// out of 'live' by wall clock instead of getting stuck in a mutable status.

export type SourceId = 'claude' | 'codex';

export interface Header {
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  title?: string;
}

export interface ActivityBlock {
  kind: 'text' | 'tool_use' | 'tool_result' | 'reasoning' | 'compaction' | 'metadata' | 'plain' | 'raw';
  label?: string;
  text?: string;
  tool?: string;
  summary?: string;
  // Raw tool_use input. Carried so the Agent Panel can render richer views
  // (e.g. unified diffs for Edit) without re-fetching the transcript.
  input?: Record<string, unknown>;
  preview?: string;
  // Set on tool_result blocks whose preview was capped by the adapter.
  // hiddenChars = bytes the sidecar dropped; hiddenLines = newline count in
  // the dropped portion. UI surfaces both as a "+N lines / +M chars" footer.
  hiddenChars?: number;
  hiddenLines?: number;
  // Pairing key linking a tool_use to its tool_result. Codex carries this
  // as `call_id` on both function_call and function_call_output payloads;
  // Claude carries `id` on tool_use and `tool_use_id` on tool_result. The
  // adapter normalizes both to this single field so the Agent Panel can group
  // a call and its response without source-branching.
  callId?: string;
}

export interface ParsedLine {
  ts: number;
  type: 'user' | 'assistant' | 'reasoning' | 'system';
  blocks: ActivityBlock[];
}

export interface ActivityEvent extends ParsedLine {
  index: number;
}

// Per-line result. Any field may be absent.
//   event:      emit as an ActivityEvent (drives activity feed + snippet)
//   turnClosed: turn-boundary signal. `false` when the line opens or
//               continues a turn (user message, task_started, non-terminal
//               assistant output); `true` when it carries a terminal marker
//               (Claude end_turn, Codex task_complete / turn_aborted).
//               Absent on lines that say nothing about turn state.
//   title:      session-title update parsed from a transcript line (Claude
//               emits ai-title lines mid-session). Watcher applies to
//               session.title so notifications can name the session.
// Latest known context-window occupancy for the session. `current` is the
// number of tokens in the most recent prompt the model actually processed
// (Claude: assistant.message.usage input + cache_creation + cache_read +
// output; Codex: event_msg.token_count info.last_token_usage.total_tokens).
// Compaction is implicit: post-compaction turns report a smaller `current`
// automatically. `limit` is the model's context window when published in
// the transcript (Codex), otherwise null and the Agent Panel supplies a
// per-model default.
export interface TokenUsage {
  current: number;
  limit: number | null;
  updatedAt: number;
}

export interface LineResult {
  event?: ParsedLine;
  turnClosed?: boolean;
  title?: string;
  usage?: TokenUsage;
  // Latest top-level cwd observed on this transcript line. Some harnesses keep
  // a session alive across a repo rename/move; the watcher uses this as
  // evidence to reconcile stale header project paths without rewriting the
  // transcript.
  cwd?: string;
}

// One observed session, from any source. The shape is the same across
// sources; `source` discriminates so the renderer can pick a brand mark or
// gate source-specific UI affordances (e.g. tmux attach is Claude-only).
export interface Session {
  sessionId: string;
  source: SourceId;
  project: string;
  projectName: string;
  transcriptPath: string;
  // Whether the most recent turn-boundary signal observed in this transcript
  // was a terminal marker. `false` means the last observed turn is still
  // open. Combined with `lastEventAt` recency at read time to derive the
  // 'live' bin; never reconciled or swept.
  lastTurnClosed: boolean;
  lastEventAt: number;
  lastSnippet: string;
  // Byte position up to which the sidecar has parsed this transcript. Always
  // resets to 0 on sidecar boot; the watcher re-scans from start, populating
  // the activity index and turn-boundary state in one pass.
  knownSize: number;
  // Codex carries a human/auto title in its SQLite index; Claude writes an
  // `ai-title` line into the transcript. The watcher fills this in on the
  // fly and refreshes it from the source on idle transitions. UI falls back
  // to lastSnippet when title is absent.
  title?: string;
  // First non-synthetic user prompt seen during drain. Used as the
  // notification subtitle when `title` is still empty (short sessions where
  // the harness hasn't summarized yet). Set once per session; the first
  // prompt is what the session is about, so it doesn't churn with turns.
  firstPrompt?: string;
  // Most recent non-synthetic user prompt. Updated on every user turn so the
  // idle notification can show what the human last asked, not just what the
  // session was opened for. Empty until the first real user message.
  lastUserPrompt?: string;
  gitBranch?: string;
  entrypoint?: string;
  tmuxSession?: string;
  tokenUsage?: TokenUsage;
}

// Compact per-session view for the observer agent. Carries enough context to
// answer "what is this session about and what's it touching" without the cost
// of streaming the full transcript. Computed on demand by routes/sessions.ts;
// no persistence.
//
// The "recent" arrays are scoped to a time window (default 15 min); the
// "session" arrays span the whole indexed history (subject to scanCap).
// `available` carries truncation signals the model can read to decide whether
// to widen its next call.
// Activity bin derived at read time from `lastTurnClosed` and
// `now - lastEventAt` against config.{liveWindowMs, readyThresholdMs,
// staleThresholdMs}, so every caller sees the same bins. See
// overview-agents/Overview.md for the rubric.
export type Bin = 'live' | 'ready' | 'paused' | 'cold';

export interface SessionDigestMessage {
  ts: number;
  text: string;
  // True when the adapter's block text was longer than `textChars` and the
  // returned `text` is a head-slice. Lets the model decide whether to widen
  // textChars on the next call without first widening blindly.
  truncated: boolean;
}

export interface SessionDigestTurn {
  user: SessionDigestMessage;
  assistantAfter: SessionDigestMessage | null;
}

export interface SessionDigestToolCount {
  tool: string;
  count: number;
}

export interface SessionDigestAvailable {
  eventsScanned: number;
  totalEvents: number;
  scanTruncated: boolean;
  recentMessagesAvailable: { user: number; assistant: number };
  recentFilesAvailable: number;
  recentToolsAvailable: number;
  sessionFilesAvailable: number;
  sessionToolsAvailable: number;
}

export interface SessionDigest {
  sessionId: string;
  source: SourceId;
  project: string;
  projectName: string;
  transcriptPath: string;
  title?: string;
  firstPrompt?: string;
  lastUserPrompt?: string;
  lastSnippet?: string;
  gitBranch?: string;
  entrypoint?: string;
  tmuxSession?: string;
  tokenUsage?: TokenUsage;
  // True when the adapter classifies this session as harness-spawned
  // auxiliary (review, approval-assessment, evaluator). See
  // `SourceAdapter.isAuxiliarySession`. Cross-project digests skip
  // auxiliaries when picking a project's primary by default.
  auxiliary: boolean;
  lastEventAt: number;
  // Timestamps of the newest user-text and assistant-text events seen during
  // the scan, independent of the messageN cap. Null when no such event exists
  // in the scanned window. Use these to rank sessions by "newest human ask"
  // or "newest model reply" without scanning recentMessages.
  lastUserMessageAt: number | null;
  lastAssistantMessageAt: number | null;
  // Precomputed bin against the sidecar's thresholds. Callers can filter on
  // this via `?bin=` instead of recomputing client-side from lastTurnClosed +
  // lastEventAt + /api/config.
  bin: Bin;
  recentMessages: {
    user: SessionDigestMessage[];
    assistant: SessionDigestMessage[];
  };
  recentTurns: SessionDigestTurn[];
  recentFiles: string[];
  recentTools: SessionDigestToolCount[];
  sessionFiles: string[];
  sessionTools: SessionDigestToolCount[];
  available: SessionDigestAvailable;
}

// Project-level digest built from the project's recent Claude/Codex sessions.
// Carries enough deterministic evidence to answer what each project is doing
// in one round trip without reading raw transcript roots.
export interface ProjectDigestOtherSession {
  sessionId: string;
  source: SourceId;
  bin: Bin;
  auxiliary: boolean;
  lastEventAt: number;
  title?: string;
  lastUserPrompt?: string;
  transcriptPath: string;
}

export interface ProjectDigest {
  project: string;
  projectName: string;
  // Source of the primary session.
  source?: SourceId;
  sources: SourceId[];
  // Newest lastEventAt across every session on this project.
  lastEventAt: number | null;
  // Bin of the primary session.
  bin: Bin | null;
  // Headline session for this project.
  primary: SessionDigest | null;
  // Full digests for the newest relevant sessions on this project, bounded by
  // the caller's `sessions` param.
  sessions: SessionDigest[];
  // Sessions not returned in `sessions`, recency-sorted and compact.
  otherSessions: ProjectDigestOtherSession[];
  evidence: {
    sessionCountBySource: Partial<Record<SourceId, number>>;
    auxiliarySessionCount: number;
    latestUserPrompt?: string;
    latestAssistantOutcome?: string;
    recentTurns: SessionDigestTurn[];
    provenance: {
      sessionIds: string[];
      transcriptPaths: string[];
    };
  };
}

// Discovery handle returned by an adapter. `initialScan` walks existing files
// (awaitable), `teardown` closes every live watcher the adapter attached.
// `rescan` re-enumerates session files without re-attaching watchers; the
// sidecar calls it periodically as a safety belt so files missed by the live
// watcher (macOS fs.watch can silently drop events under burst writes or
// FSEvents flakiness) still get registered without waiting for restart.
export interface DiscoveryHandle {
  initialScan(): Promise<void>;
  rescan(): Promise<void>;
  teardown(): void;
}

// Adapter owns layout knowledge and per-line parsing; sidecar owns scheduling,
// byte cursors, turn-boundary folding, and notifications.
export interface SourceAdapter {
  id: SourceId;

  // Set up live directory watchers and return a handle. `onSessionFile` is
  // invoked every time a session file is created or appended to (including
  // resurrected files in old leaf directories). Live emissions are
  // fire-and-forget; `initialScan` awaits each emission so the sidecar can
  // wait for boot drains to complete before going live.
  startDiscovery(onSessionFile: (path: string) => Promise<void> | void): DiscoveryHandle;

  // Map a path to a session id. Returns null if the path is not a session
  // this adapter handles.
  filePathToSessionId(path: string): string | null;

  // Read the header from a session file. Called once per session when the
  // sidecar first sees a path it has no record of.
  readHeader(path: string): Promise<Header | null>;

  // Parse one JSONL line. Every nonempty physical record returns an activity
  // event, optionally alongside state updates such as turn, title, cwd, and
  // usage. Only an empty physical line returns null.
  processLine(line: string): LineResult | null;

  // Build a one-line summary snippet from a parsed event for the rail row.
  // Adapter owns vocabulary (Claude has arrow-prefixed tool labels, Codex
  // uses plain text). Empty string means "no snippet from this event."
  snippetFor(parsed: ParsedLine): string;

  // Optional out-of-band title refresh. Codex stores the session title in a
  // SQLite index that may update after the rollout JSONL was written; the
  // watcher calls this on idle transitions so notifications include the
  // freshest name. Adapters whose titles arrive in-band (Claude's ai-title
  // line) can omit this.
  refreshTitle?(sessionId: string): Promise<string | null>;

  // Returns true when the session is a harness-spawned auxiliary (review,
  // approval-assessment, sub-task evaluator) rather than work the human is
  // actually steering. Cross-project digests skip auxiliaries when picking
  // a project's primary session unless the project has nothing else. The
  // signal is source-specific (Codex spawns approval-assessment runs whose
  // titles start with a fixed review prompt); adapters that have no such
  // concept can omit this method.
  isAuxiliarySession?(session: Session): boolean;

  // Re-parse a single JSONL line and return the UNCAPPED content of the
  // block at `blockIndex` in the resulting event. The standard processLine
  // path caps tool_result previews so memory stays bounded; this method is
  // used by the Agent Panel's "Show full output" affordance to fetch the
  // original bytes on demand. Returns null when the line, block index, or
  // block kind does not yield a textual payload.
  //
  // Async because the Claude harness can persist large bash output to a
  // sidecar file (`<persisted-output>...</persisted-output>` marker in the
  // transcript). The adapter resolves the sidecar path and reads it lazily.
  extractBlockRaw?(line: string, blockIndex: number): Promise<string | null>;
}
