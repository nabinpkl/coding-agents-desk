"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDataSource } from "./data-source/AgentDataSourceContext";
import { seedRange, olderRange } from "./data-source/eventPaging";

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

export function useSessionEventsStream(sessionId: string) {
  const ds = useDataSource();

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
    let unsubscribe: (() => void) | null = null;

    (async () => {
      try {
        const probe = await ds.fetchEventsPage(sessionId, 0, 1);
        if (cancelled) return;
        const total = probe.total;

        const { offset, limit } = seedRange(total);
        let initial: ActivityEvent[] = [];
        if (limit > 0) {
          const data = await ds.fetchEventsPage(sessionId, offset, limit);
          if (cancelled) return;
          initial = data.events;
        }
        if (cancelled) return;

        const map = new Map<number, ActivityEvent>();
        for (const ev of initial) map.set(ev.index, ev);
        setState({ events: map, total, windowStart: offset, loading: false, error: null });

        unsubscribe = ds.subscribeSessionEvents(sessionId, total, {
          onEvent: (ev) => {
            setState((s) => {
              if (s.events.has(ev.index)) return s;
              const newMap = new Map(s.events);
              newMap.set(ev.index, ev);
              return { ...s, events: newMap, total: Math.max(s.total, ev.index + 1) };
            });
          },
          onOpen: () => setConnected(true),
          onError: () => setConnected(false),
        });
      } catch (e) {
        if (!cancelled) setState((s) => ({ ...s, error: String((e as Error).message ?? e), loading: false }));
      }
    })();

    return () => {
      cancelled = true;
      if (unsubscribe) unsubscribe();
    };
  }, [sessionId, ds]);

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current) return;
    const currentStart = windowStartRef.current;
    if (currentStart <= 0) return;
    loadingOlderRef.current = true;
    try {
      const { targetStart, limit } = olderRange(currentStart);
      const data = await ds.fetchEventsPage(sessionId, targetStart, limit);
      setState((s) => {
        const newMap = new Map(s.events);
        for (const ev of data.events) newMap.set(ev.index, ev);
        return { ...s, events: newMap, windowStart: Math.min(s.windowStart, targetStart) };
      });
    } finally {
      loadingOlderRef.current = false;
    }
  }, [sessionId, ds]);

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
