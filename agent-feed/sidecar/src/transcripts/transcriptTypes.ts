// The adapter seam: each adapter knows its own JSONL layout and translates one
// line into an optional ActivityEvent plus whatever state that line updates --
// turn boundary, title, cwd, context occupancy, and whether the nice view keeps
// it. The sidecar owns catalog watching, reading pages by byte position, and streaming.
//
// The shapes an adapter EMITS are the wire contract and live in
// `agent-feed/wire`, one definition shared with the Agent Panel; they are
// re-exported here so adapters keep importing their types from one place. What
// stays local is what never leaves this process: the per-line result the
// adapter hands back, and the on-disk session record with its transcript path.
//
// Liveness is never stored: the BIN depends on the clock, so it is derived at
// read time from transcript recency plus the last turn signal. The turn signal
// itself rides the session record, put there by the same bounded metadata read
// that discovered the session. Listing sessions opens no transcript body.

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

export type TranscriptSourceId = Exclude<SourceId, 'pi' | 'opencode'>;

/**
 * How much of a tool result rides an event, in string length (about a megabyte of ASCII). Past it
 * the block carries `hiddenChars`/`hiddenLines` and "Show full output" fetches the rest. One value
 * for every provider and both the transcript and live paths, so a result reads the same however
 * it arrived.
 */
export const TOOL_RESULT_PREVIEW_CAP = 1_000_000;

// What a bounded metadata read yields about a session, without reading its body.
//
// Everything the session LIST renders comes from here. The read that produces it
// is two 32 KB edges, and it already had to happen to learn `cwd`, so the fields
// below are extracted from bytes that were in the buffer anyway.
export interface Header {
  sessionId?: string;
  /**
   * Where the session OPENED. This is its project.
   *
   * The first one in the file, deliberately, because the harness stamps `cwd` on every line and
   * an agent that runs `cd` changes it for the rest of the session. Taking the last one instead
   * filed sessions under whichever subdirectory a shell happened to be in -- one repo's history
   * split across three phantom projects named after its own subfolders.
   */
  cwd?: string;
  /**
   * Every distinct `cwd` the read windows carry, newest first: where the agent's shell has been,
   * not where the project is.
   *
   * Carried only so a RENAMED project can still be found: when `cwd` no longer exists on disk,
   * these are the paths to fall back to. That existence test is the whole discriminator -- a rename
   * leaves the original path gone, a `cd` leaves it exactly where it was. A list rather than the
   * newest alone, because the newest can be gone too: an agent that ran its last command in a
   * scratch directory it then deleted left its session filed nowhere.
   */
  recentCwds?: string[];
  gitBranch?: string;
  /** What started the session: the head's launcher, not whatever surface wrote last. */
  entrypoint?: string;
  title?: string;
  /**
   * Turn state as of the last boundary-bearing line in the TAIL edge, absent when
   * that edge carries none.
   *
   * Only the tail contributes: a boundary read from the head of a large file
   * describes the start of the session, not whether its turn is open now.
   */
  lastTurnClosed?: boolean;
  /**
   * The newest record `timestamp` in the TAIL edge, as epoch ms, absent when that edge carries
   * none. This, not the file's mtime, is when the session last did something: a running CLI
   * re-touches an idle session's transcript without writing a record (measured 2026-10-11, six
   * workers idle since Oct 3 all moved to "03:01 today" and jumped to the top of the list).
   */
  lastRecordAt?: number;
  /**
   * The session's opening prompt, from the HEAD edge, for sessions that never got
   * a title. The fallback exists because a titleless session would otherwise
   * render as its own UUID.
   */
  firstPrompt?: string;
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
/**
 * What the harness says this session's model IS, from a record that declares it rather than one
 * that reports having used it.
 *
 * The two differ, and the difference is a whole context window. Claude's `message.model` carries
 * the API's name for the model and nothing else: 94,417 records in this project say
 * `claude-opus-5`, not one of them says which window that run was given. The harness's own id
 * keeps it -- `claude-opus-5[1m]` -- and the CLI resolves the window from exactly that suffix, by
 * a regex on the name (2.1.270: `/\[1m\]/i` -> 1,000,000, everything else -> a hardcoded
 * 200,000). So the tier is part of the model's identity and the usage record is where it is lost.
 *
 * The `limit` is resolved by the adapter, which is the layer that owns the window table, and rides
 * along rather than being looked up again later.
 */
export interface DeclaredModel {
  /** The harness's own id, tier included. */
  model: string;
  limit: number | null;
}

export interface LineResult {
  event?: ParsedLine;
  turnClosed?: boolean;
  title?: string;
  usage?: TokenUsage;
  /**
   * A line that names this session's model without reporting occupancy.
   *
   * Kept apart from `usage` because a declaration is not a reading: folding one in as an
   * occupancy report with no tokens in it would put a meter reading of zero on a session that
   * has a full context and simply has not spoken since it was resumed.
   */
  declaredModel?: DeclaredModel;
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
// Absent for backends that serve their own data over an API instead of a file
// (opencode): no transcript reader may be asked for such a session, and the
// timeline route never does -- it resolves backends before transcripts.
export interface Session {
  sessionId: string;
  source: SourceId;
  project: string;
  transcriptPath?: string;
  lastEventAt: number;
  // Codex carries a title in SQLite, Pi in its header line, Claude in the bounded
  // header read's two edges (`aiTitle` / `customTitle`).
  title?: string;
  gitBranch?: string;
  entrypoint?: string;
  // The two fields the session list needs that are not identity. Carried on the
  // record rather than derived per read, because the read that produced the rest
  // of this record is the only one that should ever open the transcript to build
  // a list. Both optional: a source that cannot answer cheaply leaves them unset
  // and the summary falls back.
  lastTurnClosed?: boolean;
  firstPrompt?: string;
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
