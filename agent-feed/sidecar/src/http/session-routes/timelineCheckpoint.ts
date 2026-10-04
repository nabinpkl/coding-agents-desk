// Handing a follower the state, rather than the changes that produced it.
//
// A thread stream is an attach, and this repo already writes down what an attach means. From
// `tmuxAttachment.ts`: "The pipe starts at now. It carries what the program writes from the moment
// it is set and nothing before, so a joining viewer's first screen has to come from
// `capture-pane`." Two kinds, never conflated -- the whole prior state as one payload, and a live
// channel carrying only what happens after it. When a viewer needs that state again,
// `TmuxSessionConnection.requestCheckpoint` hands over the entire screen in one message instead of
// replaying the stream that drew it.
//
// The runtime-backed half of the timeline already obeys the same rule: `LiveAgentProjection`
// answers a follower that is further behind than its replay buffer with a snapshot of its last 100
// rows. The transcript-backed half did not, and its replay buffer is the whole file, so it had no
// bound: every line the index produced became its own `upsert`, however many landed at once.
//
// What that cost, measured 2026-09-13. `claude --resume --fork-session` writes no transcript until
// the fork's first turn and then writes the WHOLE resumed conversation at once -- one fork's file
// here held 598 records timestamped older than the file itself and 1 written at its own time, the
// copies keeping their original timestamps and carrying the new session's id. The catalog
// publishes a session within `watchTree`'s 20ms of its first flush, so the opening window can be
// taken while the file is still ten config lines long and empty in nice mode, and the resumed
// conversation then arrives as hundreds of separate live appends. The panel renders one row per
// message and follows its own bottom, so a reader watched the conversation they had just resumed
// scroll past from its first line.
//
// The trigger below is deliberately a property of the FOLLOWER rather than of the record. "Is this
// line replayed history" is answerable for a Claude transcript, and it would fix the fork and
// nothing else. "Am I further behind than a window" is true of the fork, of a stream that opened
// while a file was still being written, and of whatever causes it next -- and it is the question
// the projection has been asking all along.

import type {
  ActivityEvent,
  EventMode,
  TimelineEnvelope,
  TokenUsage,
} from "@agentdesk/agent-feed-wire";

/**
 * How many of a session's most recent events one window carries.
 *
 * Two jobs, and they are the same number on purpose. It sizes what a reader is given when a thread
 * opens, everything before it being paged in on demand. It is also the bound on catching up: a
 * follower further behind than this is handed the window instead of the rows, because it is the
 * most of a record a reader was ever going to be shown at once anyway.
 */
export const TIMELINE_WINDOW = 100;

/** Collects what the index produces and decides how the follower hears about it. */
export interface TimelineFollower {
  /** One event the index has produced, already in this follower's own mode. */
  offer(event: ActivityEvent): void;
  /** Drops anything not yet written. Called when the subscriber leaves. */
  close(): void;
}

/**
 * A follower that writes appends while it is keeping up and checkpoints when it is not.
 *
 * Transport-free and source-free: it takes events and hands back envelopes, so the transcript
 * stream, and anything else that grows a record a row at a time, can share one rule about when a
 * reader stops being shown changes.
 */
export function createTimelineFollower(options: {
  mode: EventMode;
  /**
   * Session occupancy at the moment an envelope is written.
   *
   * A function rather than a value because occupancy rides every envelope and the index folds a
   * new reading on every line it parses, so a captured one is stale by the time it is sent.
   */
  usage: () => TokenUsage | null;
  emit: (envelope: TimelineEnvelope) => void;
  /**
   * Whether an index means the same row on every open of this record.
   *
   * It decides what a checkpoint MEANS and so it cannot be assumed here. True for an append-only
   * record such as a transcript, where the checkpoint is a window onto something the reader may
   * hold more of and their scrollback survives it. False for a projection that renumbers, where
   * the checkpoint replaces everything they had. `TimelineEnvelope.stableIndices` carries the
   * whole argument.
   */
  stableIndices: boolean;
  /** The catch-up bound. Only tests pass one; everything else wants `TIMELINE_WINDOW`. */
  window?: number;
}): TimelineFollower {
  const { mode, usage, emit, stableIndices } = options;
  const window = options.window ?? TIMELINE_WINDOW;
  // Keyed by index, last write winning, because the index re-notifies an event it has already
  // emitted in order to hang a cache-hit badge on it. Held as two entries, one flush would deliver
  // the stale row after the fresh one.
  const pending = new Map<number, ActivityEvent>();
  let scheduled = false;
  let closed = false;

  const flush = (): void => {
    scheduled = false;
    if (closed || pending.size === 0) return;
    const events = [...pending.values()].sort((left, right) => left.index - right.index);
    pending.clear();
    // One past the newest row's index orders an envelope after every one before it; for a
    // transcript that is a byte inside the newest line, which no earlier line can reach.
    const sequence = events[events.length - 1]!.index + 1;
    if (events.length <= window) {
      for (const event of events) {
        emit({
          kind: "upsert",
          sequence: event.index + 1,
          mode,
          events: [event],
          windowStart: event.index,
          runState: "idle",
          queue: { steer: 0, followUp: 0 },
          usage: usage(),
        });
      }
      return;
    }
    const kept = events.slice(-window);
    emit({
      kind: "snapshot",
      sequence,
      mode,
      events: kept,
      // 0 only when nothing precedes the window, as on every page.
      windowStart: kept[0]!.previous === null ? 0 : kept[0]!.index,
      runState: "idle",
      queue: { steer: 0, followUp: 0 },
      // On an append-only record this is a WINDOW onto something the reader may already hold more
      // of rather than a replacement: whatever they had paged in below `windowStart` survives it,
      // and the rows between that and here become scrollback to be asked for rather than a stream
      // to be watched. That is the whole of what this rule is for, and the flag is what says it.
      stableIndices,
      usage: usage(),
    });
  };

  return {
    offer(event) {
      if (closed) return;
      pending.set(event.index, event);
      if (scheduled) return;
      scheduled = true;
      // A microtask rather than a timer, so one synchronous run of the index's scan is one
      // decision and a live append is never held back by a clock. The index reads a file in 1MB
      // chunks and awaits between them, so catching up on a large file decides once per chunk:
      // a few checkpoints, each a real window onto a real state, rather than one. That is the
      // cost of not delaying the ordinary case, and it is paid only while catching up.
      queueMicrotask(flush);
    },
    close() {
      closed = true;
      pending.clear();
    },
  };
}
