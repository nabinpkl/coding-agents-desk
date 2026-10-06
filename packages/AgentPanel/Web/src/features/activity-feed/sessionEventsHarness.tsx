// A session for the stream hook's tests that opens the way the sidecar opens one: the timeline
// stream's first message is a snapshot of the newest window, and rows are paged in before, after
// or around a position. Rows are ordinals here, as a runtime-backed session's are; the transcript's
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
import type { EventsPageAt } from "@agentdesk/agent-feed-wire";
import { stubDataSource } from "@/features/activity-feed/data-source/stubDataSource";
import { useSessionEventsStream, type ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

export function event(index: number, id: string, type: ActivityEvent["type"]): ActivityEvent {
  return { index, id, revision: 0, phase: "complete", ts: index, type, blocks: [] };
}

/** `limit` of `rows` read from where `at` says, answered the way every page route answers. */
export function pageOf(rows: readonly ActivityEvent[], at: EventsPageAt, limit: number): EventsPage {
  if ("before" in at) {
    const below = rows.filter((row) => at.before === null || row.index < at.before);
    const events = below.slice(-limit);
    const older = below.length > events.length;
    return { events, windowStart: older ? events[0]!.index : 0, usage: null };
  }
  const position = "after" in at ? at.after : at.around;
  const from = rows.findIndex((row) => "after" in at ? row.index > position : row.index >= position);
  const start = from < 0
    ? rows.length
    : "after" in at ? from : Math.max(0, from - Math.floor(limit / 2));
  const events = rows.slice(start, start + limit);
  return { events, windowStart: start === 0 ? 0 : (events[0]?.index ?? position), usage: null };
}

type PageAnswer = (at: EventsPageAt, limit: number) => Promise<EventsPage>;

export interface ThreadHarness {
  source: AgentDataSource;
  /** The stream's handlers, once the hook has subscribed. */
  handlers(): SessionEventsHandlers;
  /** Every page asked for, as `[at, limit]`. */
  pages: Array<[EventsPageAt, number]>;
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
  const pages: Array<[EventsPageAt, number]> = [];
  let answer: PageAnswer = async (at, limit) => pageOf(rows, at, limit);
  const source = stubDataSource({
    fetchEventsPage: (_session, at, limit) => {
      pages.push([at, limit]);
      return answer(at, limit);
    },
    subscribeSessionEvents: (_session, _after, next) => {
      handlers = next;
      if (opening !== null) {
        const page = pageOf(rows, { before: null }, 100);
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
