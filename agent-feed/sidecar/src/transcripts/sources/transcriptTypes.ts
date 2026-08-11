// The adapter seam: each adapter knows its own JSONL layout and translates one
// line into an optional ActivityEvent plus whatever state that line updates --
// turn boundary, title, cwd, context occupancy, and whether the nice view keeps
// it. The sidecar owns catalog watching, on-demand byte indexing, and streaming.
//
// The shapes an adapter EMITS are the wire contract and live in
// `agent-feed/wire`, one definition shared with the Agent Panel; they are
// re-exported here so adapters keep importing their types from one place. What
// stays local is what never leaves this process: the per-line result the
// adapter hands back, and the on-disk session record with its transcript path.
//
// Liveness is never stored. A selected-project probe combines transcript
// recency with the latest bounded turn signal and derives the bin at read time.

import type { ParsedLine, SourceId, TokenUsage, EventCacheHit } from "@agentdesk/agent-feed-wire";

export type {
  ActivityBlock,
  ActivityEvent,
  Bin,
  EventCacheHit,
  EventMode,
  ParsedLine,
  SourceId,
  TokenUsage,
} from "@agentdesk/agent-feed-wire";

export type TranscriptSourceId = Exclude<SourceId, 'pi'>;

export interface Header {
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  title?: string;
}

// Whether the nice view lets a line through. `machinery` means everything the
// line would render is a harness state dump or a value a later record of the same
// kind supersedes; `content` is everything a person wrote, a model produced, or a
// tool did. Content is the DEFAULT, so a record type a future harness release
// invents shows up as an unfamiliar row rather than silently vanishing. See
// lineClass.ts for the rule and the per-source tables.
export type LineClass = 'content' | 'machinery';

// Per-line result. Any field may be absent.
//   event:      emit as an ActivityEvent (drives activity feed + snippet)
//   turnClosed: turn-boundary signal. `false` when the line opens or
//               continues a turn (user message, task_started, non-terminal
//               assistant output); `true` when it carries a terminal marker
//               (Claude end_turn, Codex task_complete / turn_aborted).
//               Absent on lines that say nothing about turn state.
//   title:      session-title update parsed from a transcript line (Claude
//               emits ai-title lines mid-session).
export interface LineResult {
  event?: ParsedLine;
  turnClosed?: boolean;
  title?: string;
  usage?: TokenUsage;
  // Per-turn prompt cache summary. On a content line (Claude assistant usage) it
  // rides the event emitted for that line; on a machinery line (Codex
  // `token_count`) the read path re-stamps it onto the previous content event.
  cacheHit?: EventCacheHit;
  // Set by the adapter, which is the only layer that knows its own record layout.
  // Absent means 'content': the raw view renders every line regardless, and this
  // only gates the nice index.
  lineClass?: LineClass;
  // Latest top-level cwd observed on this transcript line.
  cwd?: string;
}

// One observed session, from any source. The shape is the same across
// sources; `source` discriminates so the renderer can pick a brand mark or
// gate source-specific UI affordances (e.g. tmux attach is Claude-only).
//
// Local, not wire: `transcriptPath` is a path on the host's disk, and the
// catalog projects this into a `SessionSummary` before anything is published.
export interface Session {
  sessionId: string;
  source: SourceId;
  project: string;
  transcriptPath: string;
  lastEventAt: number;
  // Codex carries a title in SQLite; Claude title lines are discovered by the
  // bounded selected-project probe.
  title?: string;
  gitBranch?: string;
  entrypoint?: string;
}

// Adapters own only source-specific JSONL parsing. Catalog discovery and
// metadata reads live outside this interface so inventory cannot accidentally
// trigger transcript indexing.
export interface SourceAdapter {
  id: TranscriptSourceId;

  // Parse one JSONL line. Every nonempty physical record returns an activity
  // event, optionally alongside state updates such as turn, title, cwd, usage,
  // and its line class. Only an empty physical line returns null.
  processLine(line: string): LineResult | null;

  // Build a one-line summary snippet from a parsed event for the rail row.
  // Adapter owns vocabulary (Claude has arrow-prefixed tool labels, Codex
  // uses plain text). Empty string means "no snippet from this event."
  snippetFor(parsed: ParsedLine): string;

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
