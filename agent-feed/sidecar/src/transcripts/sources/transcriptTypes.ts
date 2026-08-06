// Canonical, source-agnostic types. The Claude and Codex adapters emit these
// shapes; everything above the adapter (event index, catalog, HTTP/SSE,
// Agent Panel) consumes only these.
//
// The seam: each adapter knows its own JSONL layout and translates one line
// into an optional ActivityEvent plus whatever state that line updates -- turn
// boundary, title, cwd, context occupancy, and whether the nice view keeps it.
// The sidecar owns catalog watching, on-demand byte indexing, and streaming.
//
// Liveness is never stored. A selected-project probe combines transcript
// recency with the latest bounded turn signal and derives the bin at read time.

export type SourceId = 'claude' | 'codex' | 'pi';
export type TranscriptSourceId = Exclude<SourceId, 'pi'>;

export interface Header {
  sessionId?: string;
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
  /**
   * Stable Anthropic message id (`msg_...`) when the harness/source records one.
   * The live stream names it on `message_start` and the durable transcript on
   * the assistant record's `message.id`, which is how the viewer can tell "the
   * live tail is now present in the durable transcript" and drop the tail
   * instead of duplicating it.
   */
  messageId?: string;
}

export interface ActivityEvent extends ParsedLine {
  // Stable identity across replacement updates. Transcript-backed events derive
  // this from their raw JSONL line; live providers retain one id while content
  // streams and increase `revision` instead of appending partial duplicates.
  id: string;
  // Position in the mode this event was read in.
  index: number;
  revision: number;
  phase: 'streaming' | 'complete';
  // Position of the same line in the OTHER mode, or null when it has none -- a
  // machinery line read in raw mode is absent from the nice view entirely.
  //
  // Carried so the panel can switch modes without losing the viewer's place: the
  // index it is looking at means a different line in the other view, and this is
  // the only translation available without a round trip. Absent on events read
  // through a path that does not resolve it.
  otherModeIndex?: number | null;
}

// Per-line result. Any field may be absent.
//   event:      emit as an ActivityEvent (drives activity feed + snippet)
//   turnClosed: turn-boundary signal. `false` when the line opens or
//               continues a turn (user message, task_started, non-terminal
//               assistant output); `true` when it carries a terminal marker
//               (Claude end_turn, Codex task_complete / turn_aborted).
//               Absent on lines that say nothing about turn state.
//   title:      session-title update parsed from a transcript line (Claude
//               emits ai-title lines mid-session).
// Latest known context-window occupancy for the session. `current` is the
// number of tokens in the most recent prompt the model actually processed
// (Claude: assistant.message.usage input + cache_creation + cache_read +
// output; Codex: event_msg.token_count info.last_token_usage.total_tokens).
// Compaction is implicit: post-compaction turns report a smaller `current`
// automatically.
//
// `limit` arrives RESOLVED. Codex publishes `model_context_window` in the
// transcript; Claude does not, so the adapter resolves it from the config table
// keyed on `message.model`. Either way the panel receives one shape and holds no
// model knowledge of its own. Null means this build has no window for the model,
// and the meter shows a count with no bar rather than a guessed fraction.
//
// `model` is absent on lines that name no model -- Codex `token_count` records,
// and Claude lines the harness marked `<synthetic>`. Such a line still reports
// occupancy, so the session-level merge carries the last known model and limit
// forward instead of blanking the meter (124 Codex records in this project
// publish occupancy with no window).
export interface TokenUsage {
  current: number;
  limit: number | null;
  updatedAt: number;
  model?: string;
}

// Whether the nice view lets a line through. `machinery` means everything the
// line would render is a harness state dump or a value a later record of the same
// kind supersedes; `content` is everything a person wrote, a model produced, or a
// tool did. Content is the DEFAULT, so a record type a future harness release
// invents shows up as an unfamiliar row rather than silently vanishing. See
// lineClass.ts for the rule and the per-source tables.
export type LineClass = 'content' | 'machinery';

// Which view of a transcript an index, count, page or stream addresses.
//   raw  -- every line, in file order. The fidelity guarantee.
//   nice -- content lines only, renumbered contiguously from 0.
// Event indices are mode-relative, so a mode has to travel with every request
// that names one: the same integer means different lines in the two views.
export type EventMode = 'raw' | 'nice';

export interface LineResult {
  event?: ParsedLine;
  turnClosed?: boolean;
  title?: string;
  usage?: TokenUsage;
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

export type Bin = 'live' | 'ready' | 'paused' | 'cold';

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
