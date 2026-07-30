import type { ActivityEvent, TokenUsage } from "../useSessionEventsStream";

export type AgentSource = "claude" | "codex";

export interface SessionReference {
  source: AgentSource;
  sessionId: string;
}

export interface EventsPage {
  events: ActivityEvent[];
  total: number;
  /** Session occupancy, not page occupancy: always the latest the transcript has
   *  published, even on a page of older events. */
  usage: TokenUsage | null;
}

export interface SessionEventsHandlers {
  onEvent: (ev: ActivityEvent) => void;
  /** Fired whenever a chunk carries occupancy. Separate from `onEvent` because
   *  occupancy is session state and arrives on the chunk, and because it has to
   *  land before the seed resolves as well as after. */
  onUsage?: (usage: TokenUsage | null) => void;
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
