"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataSource } from "./data-source/AgentDataSourceContext";
import { seedRange, olderRange } from "./data-source/eventPaging";
import type { AgentSource, EventMode } from "./data-source/AgentDataSource";

export interface ActivityBlock {
  kind:
    | "text"
    | "tool_use"
    | "tool_result"
    | "reasoning"
    | "compaction"
    | "metadata"
    | "plain"
    | "raw";
  label?: string;
  text?: string;
  tool?: string;
  summary?: string;
  input?: Record<string, unknown>;
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
  /** The live in-flight assistant message (the live mirror), shown below the
   *  durable rows until the durable transcript contains its `messageId`. */
  liveTail: ActivityEvent | null;
}

/** Whichever occupancy report is more recent, by the timestamp on the line that
 *  produced it. Both are already-resolved snapshots, so this picks rather than
 *  merges. */
export function newerUsage(
  left: TokenUsage | null,
  right: TokenUsage | null,
): TokenUsage | null {
  if (!left) return right;
  if (!right) return left;
  return right.updatedAt >= left.updatedAt ? right : left;
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
    liveTail: null,
  });
  const [connected, setConnected] = useState(false);
  const loadingOlderRef = useRef(false);
  const windowStartRef = useRef(0);
  const timelineEpochRef = useRef(0);
  useEffect(() => { windowStartRef.current = state.windowStart; }, [state.windowStart]);

  // Initial seed (last page) + SSE subscription. SSE never stops on scroll.
  useEffect(() => {
    timelineEpochRef.current += 1;
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
          // Hand the live tail off once it is complete AND the durable transcript
          // carries that same message (same id, complete). The transcript can
          // append rows for the same message while the live stream is still
          // delivering it (per tool step), so the tail is cleared only once the
          // live message has itself finished; otherwise a mid-stream durable row
          // would kill the tail before it appears. Runs even for a duplicate
          // revision so the handoff is not skipped by buffer dedup.
          if (
            event.phase === "complete" &&
            next.liveTail?.phase === "complete" &&
            next.liveTail?.messageId &&
            event.messageId === next.liveTail.messageId
          ) {
            next.liveTail = null;
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
          // A reconnect snapshot is authoritative: if it already contains the
          // live tail's message, the durable rows own it now.
          const liveTail = current.liveTail
            ? current.liveTail.phase === "complete" && snapshot.events.some((event) => event.messageId === current.liveTail?.messageId && event.phase === "complete")
              ? null
              : current.liveTail
            : null;
          return {
            events: new Map(snapshot.events.map((event) => [event.index, event])),
            total: snapshot.total,
            windowStart: snapshot.windowStart,
            usage: newerUsage(current.usage, snapshot.usage),
            loading: false,
            error: null,
            sequence: snapshot.state.sequence,
            runState: snapshot.state.runState,
            queue: snapshot.state.queue,
            liveTail,
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
      onLiveTail: (event) =>
        setState((current) => ({ ...current, liveTail: event })),
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
          // independent of which of the two arrives first.
          usage: newerUsage(current.usage, seedUsage),
          loading: false,
          error: null,
          sequence: current.sequence,
          runState: current.runState,
          queue: current.queue,
          liveTail: current.liveTail,
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
    liveTail: state.liveTail,
  };
}
