// One transcript line, and the occupancy that rides alongside it.
//
// Source-agnostic by construction: the Claude and Codex adapters translate their own JSONL layouts
// into these shapes, and everything above the adapter -- event index, catalog, HTTP/SSE, the Agent
// Panel -- consumes only these.

export type SourceId = 'claude' | 'codex' | 'pi';

// Which view of a transcript an index, count, page or stream addresses.
//   raw  -- every line, in file order. The fidelity guarantee.
//   nice -- content lines only, renumbered contiguously from 0.
// Event indices are mode-relative, so a mode has to travel with every request
// that names one: the same integer means different lines in the two views.
export type EventMode = 'raw' | 'nice';

export interface ActivityBlock {
  kind: 'text' | 'tool_use' | 'tool_result' | 'reasoning' | 'compaction' | 'metadata' | 'plain' | 'raw' | 'image';
  // Set on image blocks, and the only thing they carry. The bytes stay in the transcript and are
  // served by `GET .../events/<n>/blocks/<b>/image`: one pasted screenshot is tens of kilobytes of
  // base64, and it used to ride every page and every reconnect as a Plain JSON card nobody could
  // read. An image a tool returned sits right after its result and carries that result's
  // `callId`, which is how the panel draws it inside the call rather than as a row of its own.
  mediaType?: string;
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

/**
 * One turn's prompt-cache accounting, in tokens. Both numbers are counts of the
 * same prompt, so `cached / input` is the fraction served from cache.
 */
export interface EventCacheHit {
  cached: number;
  input: number;
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
  /**
   * A person wrote this line, as opposed to the harness writing it as them.
   *
   * Set only where true, so a reader can test the field. `type: "user"` is not the same question
   * and cannot answer it: a tool result, a slash command's echo, a `<system-reminder>` and a
   * compaction notice are all recorded as the user, and a summarizer that tested the type alone
   * once reported a tool result as the person speaking.
   *
   * It rides the wire rather than being re-derived in the panel because the list of envelopes is
   * long, source-specific and grows with the harnesses; a second copy of it would be wrong the
   * first time either CLI added one. `transcripts/humanTurns.ts` is the one that decides, and the
   * adapter adds what only the raw line carries: a Claude line marked `isMeta` is never flagged.
   */
  humanTurn?: true;
  /**
   * Per-turn prompt cache summary, attached to the turn's last visible row so the
   * panel can render a cache-hit badge next to the output it belongs to.
   * `cached` is the input tokens served from the prompt cache and `input` is the
   * whole prompt (cached + freshly encoded). Semantics are source-adapted:
   * Codex reports `cached_input_tokens` on its `token_count` line (which is
   * machinery, so the read path re-stamps it onto the preceding content event),
   * Claude reports `cache_read_input_tokens` on the assistant message itself.
   */
  cacheHit?: EventCacheHit;
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

// Latest known context-window occupancy for the session. `current` is the
// number of tokens in the most recent prompt the model actually processed
// (Claude: assistant.message.usage input + cache_creation + cache_read +
// output; Codex: event_msg.token_count info.last_token_usage.total_tokens).
// A compaction is reported the moment it happens, not inferred from the next
// turn. Claude's `compact_boundary` record carries what the context dropped to
// and the adapter publishes it as an occupancy report of its own; Codex writes
// a `token_count` on the line after its own boundary. Both matter because the
// next turn can be hours away, and until one arrives the meter would otherwise
// still be showing a context that no longer exists.
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
//
// `cacheTtlMs` is how long the prompt cache behind this context stays warm, so
// `updatedAt + cacheTtlMs` is the moment re-reading it stops costing 0.1x and
// rewriting it starts costing 2.0x. It is read off the request's own
// `cache_creation` breakdown rather than assumed, and it is sticky for the same
// reason `limit` is: a request that wrote nothing to the cache is a pure hit and
// names no lifetime, which is not the same as the lifetime having changed.
// Absent on providers that publish no such breakdown, and the panel then counts
// down to nothing rather than to a guess.
export interface TokenUsage {
  current: number;
  limit: number | null;
  updatedAt: number;
  model?: string;
  cacheTtlMs?: number;
}
