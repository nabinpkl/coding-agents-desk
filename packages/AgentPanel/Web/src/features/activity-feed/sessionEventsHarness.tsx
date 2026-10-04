// A session for the stream hook's tests that opens the way the sidecar opens one: the timeline
// stream's first message is a snapshot of the newest window, and older rows are paged in BEFORE
// the oldest one held. Rows are ordinals here, as a runtime-backed session's are; the transcript's
// byte positions are exercised through `previous` where a test needs gaps between indices.

import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { DataSourceProvider } from "@/features/activity-feed/data-source/AgentDataSourceContext";
import type {
  AgentDataSource,
  EventsPage,
  SessionEventsHandlers,
  SessionEventsSnapshot,
} from "@/features/activity-feed/data-source/AgentDataSource";
import type { AgentSource, EventMode } from "@/features/activity-feed/data-source/AgentDataSource";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import { useSessionEventsStream, type ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

export function event(index: number, id: string, type: ActivityEvent["type"]): ActivityEvent {
  return { index, id, revision: 0, phase: "complete", ts: index, type, blocks: [] };
}

/** The newest `limit` of `rows` below `before`, answered the way every page route answers. */
export function pageOf(rows: readonly ActivityEvent[], before: number | null, limit: number): EventsPage {
  const below = rows.filter((row) => before === null || row.index < before);
  const events = below.slice(-limit);
  const older = below.length > events.length;
  return { events, windowStart: older ? events[0]!.index : 0, usage: null };
}

type PageAnswer = (before: number | null, limit: number) => Promise<EventsPage>;

export interface ThreadHarness {
  source: AgentDataSource;
  /** The stream's handlers, once the hook has subscribed. */
  handlers(): SessionEventsHandlers;
  /** Every page asked for, as `[before, limit]`. */
  pages: Array<[number | null, number]>;
  /** Replaces how pages are answered from here on. */
  answerWith(answer: PageAnswer): void;
}

/**
 * A session holding `rows`, whose stream opens on a snapshot of the newest window. `opening`
 * overrides fields of that snapshot; `null` means the stream sends none, for a test about what
 * happens before one arrives.
 */
export function thread(
  rows: readonly ActivityEvent[],
  opening: Partial<SessionEventsSnapshot> | null = {},
): ThreadHarness {
  let handlers: SessionEventsHandlers | undefined;
  const pages: Array<[number | null, number]> = [];
  let answer: PageAnswer = async (before, limit) => pageOf(rows, before, limit);
  const source = stubDataSource({
    fetchEventsPage: (_session, before, limit) => {
      pages.push([before, limit]);
      return answer(before, limit);
    },
    subscribeSessionEvents: (_session, _after, next) => {
      handlers = next;
      if (opening !== null) {
        const page = pageOf(rows, null, 100);
        queueMicrotask(() => next.onSnapshot({
          ...page,
          state: { sequence: 1, runState: "idle", queue: { steer: 0, followUp: 0 } },
          ...opening,
        }));
      }
      return () => {};
    },
    fetchRawEvent: async () => "",
  });
  return {
    source,
    handlers: () => {
      if (!handlers) throw new Error("the hook has not subscribed yet");
      return handlers;
    },
    pages,
    answerWith: (next) => { answer = next; },
  };
}

/** Renders the hook against `source`. */
export function renderThread(
  source: AgentDataSource,
  sessionSource: AgentSource = "claude",
  mode: EventMode = "nice",
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DataSourceProvider source={source}>{children}</DataSourceProvider>
  );
  return renderHook(() => useSessionEventsStream(sessionSource, "thread", mode), { wrapper });
}

/** A snapshot message, with the state every test otherwise repeats. */
export function snapshotOf(
  events: ActivityEvent[],
  fields: Partial<SessionEventsSnapshot> & { sequence?: number } = {},
): SessionEventsSnapshot {
  const { sequence = 2, ...rest } = fields;
  return {
    events,
    windowStart: 0,
    usage: null,
    state: { sequence, runState: "idle", queue: { steer: 0, followUp: 0 } },
    ...rest,
  };
}
