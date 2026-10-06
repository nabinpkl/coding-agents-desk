"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataSource } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import { PAGE_SIZE } from "@/features/activity-feed/data-source/eventPaging";
import { useTimelineGapFill, withNewer } from "@/features/activity-feed/useTimelineGapFill";
import { lastUsageFromEvents, newerUsage } from "@/features/activity-feed/usageFromEvents";
import { retireLiveRows, splitLiveTails, visibleTails, liveRowKey } from "@/features/activity-feed/rows/liveTailBlocks";
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
  /** What orders the event. A transcript row's is the byte its line starts at, the same in both
   *  modes; a runtime-backed row's is its ordinal in the projection's mode. */
  index: number;
  /** The index of the row before this one in the same mode, or null when nothing precedes it.
   *  Absent on a runtime-backed row, whose ordinals are contiguous; see `previousIndex`. */
  previous?: number | null;
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
 * Latest context-window occupancy for the session. `limit` arrives already
 * resolved, so nothing here maps a model name to a number. `null` means the
 * sidecar has no window for the model, and the meter shows a bare count
 * instead of a fraction of a guess.
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
  /** Session lifetime spend in USD, where the backend reports one. */
  cost?: number;
}

interface State {
  events: Map<number, ActivityEvent>;
  /** The oldest held row's index while older rows exist, and 0 once the first row is held. */
  windowStart: number;
  usage: TokenUsage | null;
  /**
   * The session's current model as `providerID/modelID`, or null while unnamed. Beside usage
   * rather than derived from it: usage blanks across a post-compaction gap while the model
   * survives it, and the switcher reads this without touching the meter.
   */
  sessionModel: string | null;
  loading: boolean;
  error: string | null;
  sequence: number;
  runState: "idle" | "running" | "ended" | "error";
  queue: { steer: number; followUp: number };
  /** Every row the live mirror has published that the transcript has not reached,
   *  keyed by row id. What the reader actually sees is `visibleTails` in
   *  `rows/liveTailBlocks`, which keeps the ones still ahead of the file. */
  liveRows: Map<string, ActivityEvent>;
  /** Every message id this mirror has ever published, retired rows included. It is
   *  what tells an unmirrored transcript row apart from one the preview produced,
   *  which is the whole of `visibleTails`' second rule. */
  mirroredMessages: Set<string>;
  /** Which runtime projection produced the held rows, when the source has one. */
  projectionId: string | null;
  /** How many snapshots this subscription has applied. What re-arms the gap fill below after a
   *  snapshot overtakes one of its pages and leaves the same hole behind. */
  snapshotCount: number;
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
    windowStart: 0,
    usage: null,
    sessionModel: null,
    loading: true,
    error: null,
    sequence: 0,
    runState: "idle",
    queue: { steer: 0, followUp: 0 },
    liveRows: new Map(),
    mirroredMessages: new Set(),
    projectionId: null,
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

  // One subscription seeds and follows the thread: its opening snapshot is the newest window, and
  // everything after it arrives on the same stream. SSE never stops on scroll.
  useEffect(() => {
    timelineEpochRef.current += 1;
    // Cleared on every open, not only on unsubscribe. The stream says afresh whether the context
    // is being rewritten, so a session swapped in behind a compacting one must not inherit it.
    setCompactionSummary(null);
    // Named afresh per open like the compaction notice: a session swapped in behind another
    // must not inherit its model, and a reconnect snapshot re-names it immediately below.
    setState((current) => (current.sessionModel === null ? current : { ...current, sessionModel: null }));
    let cancelled = false;
    let seeded = false;
    const unsubscribe = ds.subscribeSessionEvents(session, 0, {
onEvent: (event) => {
        // The sidecar sends the snapshot first on every open, so a row ahead of it is one the
        // snapshot carries.
        if (!seeded) return;
        setState((current) => {
          const existing = current.events.get(event.index);
          const eventChanged = !existing || (existing.revision ?? 0) < (event.revision ?? 0);
          const events = eventChanged ? new Map(current.events) : current.events;
          if (eventChanged) events.set(event.index, event);
          // Runs even for a duplicate revision, so the handoff is not skipped by buffer dedup.
          return { ...current, events, liveRows: retireLiveRows(current.liveRows, events.values()) };
        });
      },
      onSnapshot: (snapshot) => {
        timelineEpochRef.current += 1;
        seeded = true;
        setState((current) => {
          // A live tail can arrive before the first snapshot, so an empty durable map with no
          // identity yet is still the same projection; the snapshot must not throw that row away.
          const sameProjection = current.events.size === 0 && current.projectionId === null
            ? true
            : snapshot.projectionId === undefined
              ? current.projectionId === null
              : current.projectionId === snapshot.projectionId;
          // A reconnect snapshot is authoritative: every live row whose message it already
          // carries is owned by the durable rows now.
          const liveRows = sameProjection ? retireLiveRows(current.liveRows, snapshot.events) : new Map();
          const mirroredMessages = sameProjection ? current.mirroredMessages : new Set<string>();
          // The snapshot always owns the window it covers. What it does NOT own is
          // what the reader paged in BELOW that window: on a transcript-backed
          // session those rows are still about the same lines, because the file only
          // ever grew. A runtime-backed projection can do the same only while it
          // is the same projection; a rebuilt one has different arithmetic.
          //
          // The sidecar re-sends its opening window on every open, and EventSource
          // reopens on its own after any drop, so without this a reader who had
          // scrolled up watched the transcript collapse back to its last hundred rows
          // for no reason they could see. A stall longer than a window leaves a hole
          // between what is kept and the snapshot; the gap fill below fetches it.
          // Stable indices are not enough on their own. A sidecar restart rebuilds a
          // runtime projection, and the new projection can renumber the same session.
          // Its id is the boundary: an ordinary reconnect keeps the id and the paged
          // rows; a rebuilt projection replaces them.
          const retained = snapshot.stableIndices && sameProjection
            ? Array.from(current.events.values()).filter(
                (event) => event.index < snapshot.windowStart,
              )
            : [];
          const events = new Map(retained.map((event) => [event.index, event]));
          for (const event of snapshot.events) events.set(event.index, event);
          return {
            events,
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
            // The model is authoritative per message rather than merged: the sidecar names it on
            // every envelope, so the newest naming wins and a gap that blanks usage never blanks
            // this. Null only where the sender never names one.
            sessionModel: snapshot.sessionModel ?? current.sessionModel,
            loading: false,
            error: null,
            sequence: snapshot.state.sequence,
            runState: snapshot.state.runState,
            queue: snapshot.state.queue,
            projectionId: snapshot.projectionId ?? null,
            liveRows,
            mirroredMessages,
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
      // The model lands per envelope beside usage, and survives the gap that blanks it: a
      // compaction rewrites context, never the model. Null where the sender names none.
      onSessionModel: (model) =>
        setState((current) => (current.sessionModel === model ? current : { ...current, sessionModel: model })),
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
          // Retired here as well as on a durable row, because the live row can be the late one: a
          // message that finishes after its line landed, or a tail replayed after the snapshot. A
          // streaming delta can retire nothing, so only a finished row pays for the scan.
          const added = new Map(current.liveRows).set(liveRowKey(event), event);
          const liveRows = event.phase === "complete" ? retireLiveRows(added, current.events.values()) : added;
          const mirroredMessages = event.messageId === undefined
            ? current.mirroredMessages
            : new Set(current.mirroredMessages).add(event.messageId);
          return { ...current, liveRows, mirroredMessages };
        }),
      onCompacting: setCompactionSummary,
      onOpen: () => setConnected(true),
      onError: (message) => {
        setConnected(false);
        // The snapshot is the only way a thread is seeded, so a stream that fails before sending
        // one is a thread that cannot be read; say why rather than loading forever.
        if (message !== undefined && !seeded && !cancelled) {
          setState((current) => ({ ...current, error: message, loading: false }));
        }
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [session, ds]);

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const before = windowStartRef.current;
    if (before <= 0) return;
    loadingOlderRef.current = true;
    try {
      const requestEpoch = timelineEpochRef.current;
      const data = await ds.fetchEventsPage(session, { before }, PAGE_SIZE);
      if (requestEpoch !== timelineEpochRef.current) return;
      setState((s) => {
        const newMap = new Map(s.events);
        for (const ev of data.events) newMap.set(ev.index, ev);
        return { ...s, events: newMap, windowStart: Math.min(s.windowStart, data.windowStart) };
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
    (before: number, limit: number) => ds.fetchEventsPage(session, { before }, limit),
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
    windowStart: state.windowStart,
    usage: state.usage,
    sessionModel: state.sessionModel,
    loadOlder,
    loading: state.loading,
    error: state.error,
    connected,
    sequence: state.sequence,
    runState: state.runState,
    queue: state.queue,
    snapshotCount: state.snapshotCount,
    liveTails,
    compactionSummary,
  };
}
