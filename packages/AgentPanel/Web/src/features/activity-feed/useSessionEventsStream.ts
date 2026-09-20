"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataSource } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { seedRange, olderRange } from "@/features/activity-feed/data-source/eventPaging";
import { useTimelineGapFill, withNewer } from "@/features/activity-feed/useTimelineGapFill";
import { lastUsageFromEvents, newerUsage } from "@/features/activity-feed/usageFromEvents";
import { splitLiveTails } from "@/features/activity-feed/rows/liveTailBlocks";
import type { AgentSource, EventMode } from "@/features/activity-feed/data-source/AgentDataSource";

export interface ActivityBlock {
  kind:
    | "text"
    | "tool_use"
    | "tool_result"
    | "reasoning"
    | "compaction"
    | "metadata"
    | "plain"
    | "raw"
    | "image";
  /** On an image block, and all it carries: the picture is fetched by address, not sent inline. */
  mediaType?: string;
  label?: string;
  text?: string;
  tool?: string;
  summary?: string;
  input?: Record<string, unknown>;
  /** On a tool_use: the files the call names, resolved by the sidecar. A picture among them is
   *  fetched by its POSITION here, so this order is the address and not a display choice. */
  files?: string[];
  preview?: string;
  hiddenChars?: number;
  hiddenLines?: number;
  // Pairing key linking a tool_use to its matching tool_result. Codex
  // `call_id`, Claude `tool_use.id` / `tool_result.tool_use_id`, both
  // normalized by the engine.
  callId?: string;
}

export interface ActivityEvent {
  id?: string;
  /** Position in the mode this event was read in. */
  index: number;
  revision?: number;
  phase?: "streaming" | "complete" | "error";
  ts: number;
  type: "user" | "assistant" | "reasoning" | "system";
  blocks: ActivityBlock[];
  /** Position of the same line in the other mode, or null when it has none: a
   *  machinery line read in raw mode is absent from the nice view. */
  otherModeIndex?: number | null;
  /** Stable Anthropic message id (`msg_...`), shared between the durable
   *  transcript and the live mirror so a streaming tail can hand off. */
  messageId?: string;
  /** A person wrote this line, as opposed to the harness writing it as them: a
   *  tool result, a slash command's echo and a `<system-reminder>` are all
   *  recorded as the user. Decided by the sidecar, which owns the list of
   *  envelopes; set only where true. */
  humanTurn?: true;
  /** Per-turn prompt-cache summary, attached to the turn's last visible row so
   *  a cache-hit badge can render next to the output it belongs to. Absent
   *  means the harness reported no cache data for that turn. */
  cacheHit?: EventCacheHit;
}

/**
 * One turn's prompt-cache accounting, in tokens. Both numbers count the same
 * prompt, so `cached / input` is the fraction served from cache.
 */
export interface EventCacheHit {
  cached: number;
  input: number;
}

/**
 * Latest context-window occupancy for the session.
 *
 * `limit` arrives already resolved -- the sidecar reads Codex's published window
 * and looks Claude's up in its own model table -- so nothing here maps a model
 * name to a number. `null` means the sidecar has no window for the model, and
 * the meter shows a bare count instead of a fraction of a guess.
 */
export interface TokenUsage {
  current: number;
  limit: number | null;
  updatedAt: number;
  model?: string;
  /** Lifetime of the prompt cache behind this context, so `updatedAt + cacheTtlMs`
   *  is when re-reading it stops being cheap. Resolved by the sidecar from the
   *  request's own cache breakdown; absent where the provider reports none. */
  cacheTtlMs?: number;
}

interface State {
  events: Map<number, ActivityEvent>;
  total: number;
  windowStart: number;
  usage: TokenUsage | null;
  loading: boolean;
  error: string | null;
  sequence: number;
  runState: "idle" | "running" | "ended" | "error";
  queue: { steer: number; followUp: number };
  /** Every row the live mirror has published that the transcript has not reached,
   *  keyed by row id. What the reader actually sees is `visibleTails` below, which
   *  keeps the ones still ahead of the file. */
  liveRows: Map<string, ActivityEvent>;
  /** Every message id this mirror has ever published, retired rows included. It is
   *  what tells an unmirrored transcript row apart from one the preview produced,
   *  which is the whole of `visibleTails`' second rule. */
  mirroredMessages: Set<string>;
  /** How many snapshots this subscription has applied. What re-arms the gap fill below after a
   *  snapshot overtakes one of its pages and leaves the same hole behind. */
  snapshotCount: number;
}

/** A live row's key: the mirror's own row id, stable across the revisions that
 *  grow one message, so a delta replaces its row instead of adding one. */
export function liveRowKey(event: ActivityEvent): string {
  return event.id ?? `live:${event.index}`;
}

/**
 * The live rows to draw under the thread, oldest first.
 *
 * The mirror runs AHEAD of the file: a transcript line is written after the fact, so
 * the only thing this preview is ever about is the part of the turn the reader cannot
 * see yet. Once the transcript has reached a row, the file is the authority and the
 * preview has nothing left to add for it.
 *
 * A turn is MANY messages, not one. The mirror opens a row per message, finishes it,
 * and moves on, and the transcript is what collects them into a thread. So this is a
 * list rather than a slot: holding one slot and letting each new message overwrite
 * the last is only correct while the file keeps up, and it does not. Measured
 * 2026-09-10 on a live session, the durable stream delivered nothing for ninety
 * seconds while four messages took the slot in turn, so three of them were on screen
 * for a few seconds and then nowhere at all, and the thread appeared to stop moving.
 *
 * What retires a row is therefore two separate things, and neither is a clock:
 *
 * - The file NAMING it. That is the handoff, settled on `messageId` in `onEvent`,
 *   which also retires every row the mirror published before it: the file writes
 *   messages in the order the mirror made them, so naming one says the file has
 *   reached that point in the mirror's own order.
 * - The file moving PAST it, which is what this function decides. A mirror that
 *   stops mid-turn keeps publishing a row whose id never reaches the file, so the
 *   handoff can never fire and the preview sits under a thread that is streaming
 *   perfectly well behind it. Measured 2026-09-09: a three-hour-old finished message
 *   pinned below a live session as a 9,554px block, in a feed that follows its own
 *   bottom.
 *
 * "Past" is measured against the newest transcript row for a message THIS MIRROR
 * never published, because those are the only rows that say the mirror is behind. A
 * row's `ts` is the moment its message began streaming, so a file holding an
 * unmirrored message from that moment or later is not waiting on this one. Two kinds
 * of row are deliberately ignored:
 *
 * - Rows for a message the mirror DID publish. The transcript appends per tool step
 *   and writes a message when it ends, so its row lands at about the instant the next
 *   message starts streaming; counting it would retire the row the mirror is writing
 *   right now on a coin flip. Those rows are the handoff's business, not this one's.
 * - Rows carrying no message at all -- tool results, the reader's own turns. They are
 *   written throughout a turn and belong to no message, so their arrival is not
 *   evidence about which message the file has reached.
 */
export function visibleTails(
  rows: ReadonlyMap<string, ActivityEvent>,
  durable: readonly ActivityEvent[],
  mirrored: ReadonlySet<string>,
): ActivityEvent[] {
  let newestUnmirrored = Number.NEGATIVE_INFINITY;
  for (const event of durable) {
    if (event.messageId === undefined || mirrored.has(event.messageId)) continue;
    if (event.ts > newestUnmirrored) newestUnmirrored = event.ts;
  }
  const visible: ActivityEvent[] = [];
  for (const row of rows.values()) {
    if (row.ts > newestUnmirrored) visible.push(row);
  }
  return visible.sort((left, right) => left.index - right.index);
}

export function useSessionEventsStream(
  source: AgentSource,
  sessionId: string,
  mode: EventMode,
) {
  const ds = useDataSource();
  const session = useMemo(
    () => ({ source, sessionId, mode }),
    [source, sessionId, mode],
  );

  const [state, setState] = useState<State>({
    events: new Map(),
    total: 0,
    windowStart: 0,
    usage: null,
    loading: true,
    error: null,
    sequence: 0,
    runState: "idle",
    queue: { steer: 0, followUp: 0 },
    liveRows: new Map(),
    mirroredMessages: new Set(),
    snapshotCount: 0,
  });
  const [connected, setConnected] = useState(false);
  // Not folded into `state`, because it is the one thing here that is not about events: it is set
  // precisely while none are arriving, and it survives no reconnect -- a stream that opens is told
  // afresh whether the context is being rewritten.
  const [compactionSummary, setCompactionSummary] = useState<string | null>(null);
  const loadingOlderRef = useRef(false);
  const windowStartRef = useRef(0);
  const timelineEpochRef = useRef(0);
  useEffect(() => { windowStartRef.current = state.windowStart; }, [state.windowStart]);

  // Initial seed (last page) + SSE subscription. SSE never stops on scroll.
  useEffect(() => {
    timelineEpochRef.current += 1;
    // Cleared on every open, not only on unsubscribe. The stream says afresh whether the context
    // is being rewritten, so a session swapped in behind a compacting one must not inherit it.
    setCompactionSummary(null);
    let cancelled = false;
    const pendingLive = new Map<number, ActivityEvent>();
    let seeded = false;
    let replacedBySnapshot = false;
    const unsubscribe = ds.subscribeSessionEvents(session, 0, {
onEvent: (event) => {
        if (!seeded) {
          pendingLive.set(event.index, event);
          return;
        }
        setState((current) => {
          const existing = current.events.get(event.index);
          const eventChanged = !existing || (existing.revision ?? 0) < (event.revision ?? 0);
          const events = eventChanged ? new Map(current.events) : current.events;
          if (eventChanged) events.set(event.index, event);
          const next = {
            ...current,
            events,
            total: eventChanged
              ? Math.max(current.total, event.index + 1)
              : current.total,
          };
          // Hand a live row off once it is complete AND the durable transcript
          // carries that same message (same id, complete). The transcript can
          // append rows for the same message while the live stream is still
          // delivering it (per tool step), so a row is cleared only once the live
          // message has itself finished; otherwise a mid-stream durable row would
          // kill the preview before it appears. Runs even for a duplicate revision
          // so the handoff is not skipped by buffer dedup.
          if (event.phase === "complete" && event.messageId) {
            const named = [...next.liveRows.values()].find(
              (row) => row.phase === "complete" && row.messageId === event.messageId,
            );
            // Everything the mirror published BEFORE the named row goes with it: the
            // file writes messages in the mirror's own order, so reaching one means
            // reaching all of them, and a row whose durable line has scrolled out of
            // the panel's window would otherwise linger below the thread forever.
            if (named) {
              next.liveRows = new Map(
                [...next.liveRows].filter(([, row]) => row.index > named.index),
              );
            }
          }
          return next;
        });
      },
      onSnapshot: (snapshot) => {
        timelineEpochRef.current += 1;
        replacedBySnapshot = true;
        seeded = true;
        pendingLive.clear();
        setState((current) => {
          // A reconnect snapshot is authoritative: every live row whose message it
          // already carries is owned by the durable rows now.
          const named = [...current.liveRows.values()]
            .filter(
              (row) =>
                row.phase === "complete" &&
                row.messageId !== undefined &&
                snapshot.events.some(
                  (event) => event.messageId === row.messageId && event.phase === "complete",
                ),
            )
            .reduce((newest, row) => (newest === null || row.index > newest.index ? row : newest), null as ActivityEvent | null);
          const liveRows = named
            ? new Map([...current.liveRows].filter(([, row]) => row.index > named.index))
            : current.liveRows;
          // The snapshot always owns the window it covers. What it does NOT own is
          // what the reader paged in BELOW that window: on a transcript-backed
          // session those rows are still about the same lines, because the file only
          // ever grew. On a runtime-backed one the projection has renumbered and they
          // are arithmetic about a session that no longer exists, so they go.
          //
          // The sidecar re-sends its opening window on every open, and EventSource
          // reopens on its own after any drop, so without this a reader who had
          // scrolled up watched the transcript collapse back to its last hundred rows
          // for no reason they could see. A stall longer than a window leaves a hole
          // between what is kept and the snapshot; the gap fill below fetches it.
          const retained = snapshot.stableIndices
            ? Array.from(current.events.values()).filter(
                (event) => event.index < snapshot.windowStart,
              )
            : [];
          const events = new Map(retained.map((event) => [event.index, event]));
          for (const event of snapshot.events) events.set(event.index, event);
          return {
            events,
            total: snapshot.total,
            // Only a window that actually kept something reaches below the snapshot's
            // start. On a first open there is nothing held and `current.windowStart`
            // is still 0, which would otherwise claim the whole session was loaded.
            windowStart:
              retained.length > 0
                ? Math.min(current.windowStart, snapshot.windowStart)
                : snapshot.windowStart,
            // The snapshot's structured occupancy, or -- when the runtime did
            // not deliver it -- the transcript's own last reading, which the
            // events already carry. Live readings still win later: `updatedAt`
            // on those is newer, so `newerUsage` replaces the fallback.
            usage:
              newerUsage(current.usage, snapshot.usage) ??
              lastUsageFromEvents(snapshot.events),
            loading: false,
            error: null,
            sequence: snapshot.state.sequence,
            runState: snapshot.state.runState,
            queue: snapshot.state.queue,
            liveRows,
            mirroredMessages: current.mirroredMessages,
            snapshotCount: current.snapshotCount + 1,
          };
        });
      },
      onState: (sessionState) =>
        setState((current) =>
          sessionState.sequence < current.sequence
            ? current
            : { ...current, ...sessionState },
        ),
      // Occupancy is session state, so it arrives on the chunk rather than on an
      // event, and it must land even while the seed is still in flight: on a
      // live thread the newest usage-bearing line is often the one that arrives
      // before the seed resolves.
      onUsage: (usage) =>
        setState((current) => ({
          ...current,
          usage: newerUsage(current.usage, usage),
        })),
      // The mirror publishes one row at a time and never revisits an older one, so
      // these accumulate rather than replace: the rows it opened earlier in the turn
      // are exactly the part of the turn the transcript has not caught up to. `null`
      // is the mirror going away, which invalidates the whole preview at once.
      onLiveTail: (event) =>
        setState((current) => {
          if (!event) {
            return current.liveRows.size === 0
              ? current
              : { ...current, liveRows: new Map() };
          }
          const liveRows = new Map(current.liveRows);
          liveRows.set(liveRowKey(event), event);
          const mirroredMessages = event.messageId === undefined
            ? current.mirroredMessages
            : new Set(current.mirroredMessages).add(event.messageId);
          return { ...current, liveRows, mirroredMessages };
        }),
      onCompacting: setCompactionSummary,
      onOpen: () => setConnected(true),
      onError: () => setConnected(false),
    });

    (async () => {
      try {
        const probe = await ds.fetchEventsPage(session, 0, 1);
        if (cancelled) return;
        const total = probe.total;

        const { offset, limit } = seedRange(total);
        let initial: ActivityEvent[] = [];
        let seedUsage = probe.usage;
        if (limit > 0) {
          const data = await ds.fetchEventsPage(session, offset, limit);
          if (cancelled) return;
          initial = data.events;
          seedUsage = data.usage;
        }
        if (cancelled || replacedBySnapshot) return;

        const map = new Map<number, ActivityEvent>();
        for (const ev of initial) map.set(ev.index, ev);
        for (const event of pendingLive.values()) map.set(event.index, event);
        seeded = true;
        setState((current) => ({
          events: map,
          total: Math.max(total, ...Array.from(map.keys(), (index) => index + 1), 0),
          windowStart: offset,
          // A live chunk can land before the seed resolves, so this cannot just
          // take the page's value: `updatedAt` decides, which makes the outcome
          // independent of which of the two arrives first. When neither the
          // page nor a live chunk carried structured occupancy, initialize the
          // meter from the transcript's own last reading in the seed events.
          usage:
            newerUsage(current.usage, seedUsage) ??
            lastUsageFromEvents(initial),
          loading: false,
          error: null,
          sequence: current.sequence,
          runState: current.runState,
          queue: current.queue,
          liveRows: current.liveRows,
          mirroredMessages: current.mirroredMessages,
          snapshotCount: current.snapshotCount,
        }));
      } catch (e) {
        if (!cancelled && !replacedBySnapshot) {
          setState((s) => ({
            ...s,
            error: String((e as Error).message ?? e),
            loading: false,
          }));
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [session, ds]);

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const currentStart = windowStartRef.current;
    if (currentStart <= 0) return;
    loadingOlderRef.current = true;
    try {
      const { targetStart, limit } = olderRange(currentStart);
      const requestEpoch = timelineEpochRef.current;
      const data = await ds.fetchEventsPage(session, targetStart, limit);
      if (requestEpoch !== timelineEpochRef.current) return;
      setState((s) => {
        const newMap = new Map(s.events);
        for (const ev of data.events) newMap.set(ev.index, ev);
        return { ...s, events: newMap, windowStart: Math.min(s.windowStart, targetStart) };
      });
    } finally {
      loadingOlderRef.current = false;
    }
  }, [session, ds]);

  const events = useMemo(() => {
    const arr = Array.from(state.events.values());
    arr.sort((a, b) => a.index - b.index);
    return arr;
  }, [state.events]);

  const fetchGapPage = useCallback(
    (offset: number, limit: number) => ds.fetchEventsPage(session, offset, limit),
    [session, ds],
  );
  const mergeGapPage = useCallback((page: readonly ActivityEvent[]) => {
    setState((current) => ({ ...current, events: withNewer(current.events, page) }));
  }, []);
  useTimelineGapFill({
    events,
    fetchPage: fetchGapPage,
    epochRef: timelineEpochRef,
    snapshotCount: state.snapshotCount,
    onPage: mergeGapPage,
  });

  // Derived rather than cleared on arrival, so the rule holds whatever order the two
  // sources land in. The clear inside `onEvent` still runs, to let a finished message
  // go rather than carry it; this is what decides whether it is drawn. Split per block
  // last, so a message's rows are the ones its transcript lines will replace.
  const liveTails = useMemo(
    () => splitLiveTails(visibleTails(state.liveRows, events, state.mirroredMessages), events),
    [state.liveRows, events, state.mirroredMessages],
  );

  return {
    events,
    total: state.total,
    windowStart: state.windowStart,
    usage: state.usage,
    loadOlder,
    loading: state.loading,
    error: state.error,
    connected,
    sequence: state.sequence,
    runState: state.runState,
    queue: state.queue,
    liveTails,
    compactionSummary,
  };
}
