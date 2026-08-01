import type { ActivityEvent, TokenUsage } from "../useSessionEventsStream";

export type AgentSource = string;

/**
 * Which view of a transcript to read.
 *
 * `raw` is every line in file order, the fidelity guarantee. `nice` omits harness
 * machinery and renumbers what is left contiguously from 0.
 *
 * Part of the session reference rather than a per-call argument because an event
 * index is mode-relative: the same integer names a different line in the two views,
 * so every call that carries an index has to carry the mode too, and a data source
 * that could be asked for one mode's page while holding the other's buffer would
 * silently mix them.
 */
export type EventMode = "raw" | "nice";

export interface SessionReference {
  source: AgentSource;
  sessionId: string;
  mode: EventMode;
}

export interface EventsPage {
  events: ActivityEvent[];
  total: number;
  /** Session occupancy, not page occupancy: always the latest the transcript has
   *  published, even on a page of older events. */
  usage: TokenUsage | null;
}

export interface SessionEventsSnapshot extends EventsPage {
  /** First event index present in this authoritative replacement window. */
  windowStart: number;
  state: AgentSessionState;
}

export interface SessionEventsHandlers {
  onEvent: (ev: ActivityEvent) => void;
  /** Replaces the visible session window after a reconnect. Runtime-local
   *  indexes and revisions cannot be merged across this boundary. */
  onSnapshot: (snapshot: SessionEventsSnapshot) => void;
  onState?: (state: AgentSessionState) => void;
  /** Fired whenever a chunk carries occupancy. Separate from `onEvent` because
   *  occupancy is session state and arrives on the chunk, and because it has to
   *  land before the seed resolves as well as after. */
  onUsage?: (usage: TokenUsage | null) => void;
  onOpen?: () => void;
  onError?: () => void;
}

export interface AgentSessionState {
  sequence: number;
  runState: "idle" | "running" | "ended" | "error";
  queue: { steer: number; followUp: number };
}

export type AgentSessionControlState = Pick<AgentSessionState, "runState" | "queue">;

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
