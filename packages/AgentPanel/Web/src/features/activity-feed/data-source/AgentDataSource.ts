import type { ActivityEvent } from "../useSessionEventsStream";
import type { HarnessSession, LinkState } from "../activityTypes";

export interface EventsPage {
  events: ActivityEvent[];
  total: number;
}

export interface SessionEventsHandlers {
  onEvent: (ev: ActivityEvent) => void;
  onOpen?: () => void;
  onError?: () => void;
}

export interface SessionsHandlers {
  onSessions: (sessions: HarnessSession[]) => void;
  onLink: (link: LinkState) => void;
}

export interface AgentDataSource {
  /** Fetches a page of events for a session. Throws on non-ok HTTP. */
  fetchEventsPage(sessionId: string, offset: number, limit: number): Promise<EventsPage>;

  /** Opens an SSE stream for new events after `after`. Returns unsubscribe. */
  subscribeSessionEvents(
    sessionId: string,
    after: number,
    handlers: SessionEventsHandlers,
  ): () => void;

  /** Opens an SSE stream for the sessions list. Returns unsubscribe. */
  subscribeSessions(handlers: SessionsHandlers): () => void;

  /** Fetches the exact original JSONL line for one visible event. */
  fetchRawEvent(
    sessionId: string,
    eventIndex: number,
  ): Promise<string>;
}
