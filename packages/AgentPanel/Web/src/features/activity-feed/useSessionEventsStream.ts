"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataSource } from "./data-source/AgentDataSourceContext";
import { seedRange, olderRange } from "./data-source/eventPaging";
import type { AgentSource } from "./data-source/AgentDataSource";

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
  index: number;
  ts: number;
  type: "user" | "assistant" | "reasoning" | "system";
  blocks: ActivityBlock[];
}

interface State {
  events: Map<number, ActivityEvent>;
  total: number;
  windowStart: number;
  loading: boolean;
  error: string | null;
}

export function useSessionEventsStream(
  source: AgentSource,
  sessionId: string,
) {
  const ds = useDataSource();
  const session = useMemo(
    () => ({ source, sessionId }),
    [source, sessionId],
  );

  const [state, setState] = useState<State>({
    events: new Map(),
    total: 0,
    windowStart: 0,
    loading: true,
    error: null,
  });
  const [connected, setConnected] = useState(false);
  const loadingOlderRef = useRef(false);
  const windowStartRef = useRef(0);
  useEffect(() => { windowStartRef.current = state.windowStart; }, [state.windowStart]);

  // Initial seed (last page) + SSE subscription. SSE never stops on scroll.
  useEffect(() => {
    let cancelled = false;
    const pendingLive = new Map<number, ActivityEvent>();
    let seeded = false;
    const unsubscribe = ds.subscribeSessionEvents(session, 0, {
      onEvent: (event) => {
        if (!seeded) {
          pendingLive.set(event.index, event);
          return;
        }
        setState((current) => {
          if (current.events.has(event.index)) return current;
          const events = new Map(current.events);
          events.set(event.index, event);
          return {
            ...current,
            events,
            total: Math.max(current.total, event.index + 1),
          };
        });
      },
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
        if (limit > 0) {
          const data = await ds.fetchEventsPage(session, offset, limit);
          if (cancelled) return;
          initial = data.events;
        }
        if (cancelled) return;

        const map = new Map<number, ActivityEvent>();
        for (const ev of initial) map.set(ev.index, ev);
        for (const event of pendingLive.values()) map.set(event.index, event);
        seeded = true;
        setState({
          events: map,
          total: Math.max(total, ...Array.from(map.keys(), (index) => index + 1), 0),
          windowStart: offset,
          loading: false,
          error: null,
        });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, error: String((e as Error).message ?? e), loading: false }));
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
      const data = await ds.fetchEventsPage(session, targetStart, limit);
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
    loadOlder,
    loading: state.loading,
    error: state.error,
    connected,
  };
}
