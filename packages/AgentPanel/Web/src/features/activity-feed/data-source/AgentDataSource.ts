import type { ActivityEvent } from "../useSessionEventsStream";

export type AgentSource = "claude" | "codex";

export interface SessionReference {
  source: AgentSource;
  sessionId: string;
}

export interface EventsPage {
  events: ActivityEvent[];
  total: number;
}

export interface SessionEventsHandlers {
  onEvent: (ev: ActivityEvent) => void;
  onOpen?: () => void;
  onError?: () => void;
}

export interface AgentDataSource {
  /** Fetches a page of events for a session. Throws on non-ok HTTP. */
  fetchEventsPage(
    session: SessionReference,
    offset: number,
    limit: number,
  ): Promise<EventsPage>;

  /** Opens an SSE stream for new events after `after`. Returns unsubscribe. */
  subscribeSessionEvents(
    session: SessionReference,
    after: number,
    handlers: SessionEventsHandlers,
  ): () => void;

  /** Fetches the exact original JSONL line for one visible event. */
  fetchRawEvent(
    session: SessionReference,
    eventIndex: number,
  ): Promise<string>;
}
