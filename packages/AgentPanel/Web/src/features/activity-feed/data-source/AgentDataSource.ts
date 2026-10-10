import type { ActivityEvent, TokenUsage } from "@/features/activity-feed/useSessionEventsStream";
import type {
  BackgroundTaskSnapshot,
  EventMode,
  LastSessionMessage,
  SubagentTranscriptMessage,
  TaskOutputMessage,
} from "@agentdesk/agent-feed-wire";

export type AgentSource = string;

/**
 * Which view of a transcript to read: `raw` is every line in file order, the
 * fidelity guarantee; `nice` omits harness machinery and renumbers what is left
 * contiguously from 0. Declared by the sidecar (see agent-feed/wire).
 *
 * It sits on the session reference rather than being a per-call argument because an
 * event index is mode-relative: the same integer names a different line in the two
 * views, so every call that carries an index has to carry the mode too, and a data
 * source that could be asked for one mode's page while holding the other's buffer
 * would silently mix them.
 */
export type { EventMode } from "@agentdesk/agent-feed-wire";

export interface SessionReference {
  source: AgentSource;
  sessionId: string;
  mode: EventMode;
}

export interface EventsPage {
  events: ActivityEvent[];
  /** The oldest row's index when older rows exist, and 0 when the page reaches the first row:
   *  the next older page is the one before this. */
  windowStart: number;
  /** Session occupancy, not page occupancy: always the latest the transcript has
   *  published, even on a page of older events. */
  usage: TokenUsage | null;
  /** The session's current model as `providerID/modelID`, or null while unknown.
   *  Beside usage rather than inside it: usage blanks across a post-compaction gap
   *  while the model survives it, and the switcher reads this without touching the meter. */
  sessionModel?: string | null;
  /** Identity of the runtime projection that produced this page, when the source has one. */
  projectionId?: string;
}

export interface SessionEventsSnapshot extends EventsPage {
  /** Whether this session's indices mean the same line on every open, so rows the
   *  reader paged in below `windowStart` are still about this transcript. Absent
   *  means they are not: the window replaces whatever was held. */
  stableIndices?: boolean;
  /**
   * Which runtime projection produced the window, when the source has one. A changed id is a
   * replacement boundary even if the source keeps stable indices across ordinary reconnects.
   */
  projectionId?: string;
  state: AgentSessionState;
}

export interface SessionEventsHandlers {
  onEvent: (ev: ActivityEvent) => void;
  /** Re-states the visible session window after a reconnect. Runtime-local
   *  indexes and revisions cannot be merged across this boundary, which is what
   *  `stableIndices` on the snapshot reports. */
  onSnapshot: (snapshot: SessionEventsSnapshot) => void;
  onState?: (state: AgentSessionState) => void;
  /** Fired whenever a chunk carries occupancy. Separate from `onEvent` because
   *  occupancy is session state and arrives on the chunk, and because it has to
   *  land before the seed resolves as well as after. */
  onUsage?: (usage: TokenUsage | null) => void;
  /** Fired whenever a chunk names the session's model. Separate from `onUsage` because
   *  occupancy blanks across a post-compaction gap while the model survives it, and the
   *  switcher must not blank with the meter. */
  onSessionModel?: (model: string | null) => void;
  /** The live in-flight message, mirrored from the network layer. `event` is the
   *  message as it streams; `null` means the live tail is over. The viewer shows
   *  it below the durable rows and hands it off when the durable transcript
   *  contains the same `messageId`. */
  onLiveTail?: (event: ActivityEvent | null) => void;
  /** The harness is rewriting this session's context: the summary written so far while it is, and
   *  null once it is not. It takes two to four minutes on a large context, during which the thread
   *  gains no rows and the live tail is empty, so without this the reader cannot tell a session
   *  being compacted from one that finished its turn. */
  onCompacting?: (summary: string | null) => void;
  onOpen?: () => void;
  /** The stream dropped, or the sidecar said why it could not serve this session (the message). */
  onError?: (message?: string) => void;
}

export interface AgentSessionState {
  sequence: number;
  runState: "idle" | "running" | "ended" | "error";
  queue: { steer: number; followUp: number };
}

export type AgentSessionControlState = Pick<AgentSessionState, "runState" | "queue">;

export interface AgentDataSource {
  /** Fetches the newest `limit` events below `before`, or the newest of all when it is null.
   *  Throws on non-ok HTTP. */
  fetchEventsPage(
    session: SessionReference,
    before: number | null,
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

  /**
   * Where the page can load the picture behind one image block, or null where it cannot: a
   * relayed transport has no address a browser loads by itself.
   */
  eventImageUrl(
    session: SessionReference,
    eventIndex: number,
    blockIndex: number,
  ): string | null;

  /**
   * Where the page can load a picture a tool call HANDED to the reader, by its place in that
   * call's own list of files, or null where this transport has no address a browser can load.
   *
   * Addressed by position rather than by path on purpose: the request never carries a filename,
   * so the panel can only ask for what the session already said it was sending.
   */
  eventFileUrl(
    session: SessionReference,
    eventIndex: number,
    blockIndex: number,
    fileIndex: number,
  ): string | null;

  /**
   * Follows the session's background tasks. Returns unsubscribe.
   *
   * Its own stream rather than a field on the session events, because the events stream remounts
   * when the viewer switches between raw and nice, and a task that has been running for eleven
   * minutes should not restart its clock because the transcript is being rendered differently.
   */
  subscribeBackgroundTasks(
    session: SessionReference,
    handlers: {
      onSnapshot: (snapshot: BackgroundTaskSnapshot) => void;
      onError?: (reason: string) => void;
    },
  ): () => void;

  /**
   * Follows one task's output: a snapshot of the tail, then appends. Returns unsubscribe.
   *
   * Opened when a task row is expanded and closed when it collapses -- on demand, so N tasks in
   * flight never become N open streams to a phone.
   */
  subscribeTaskOutput(
    session: SessionReference,
    taskId: string,
    handlers: {
      onMessage: (message: TaskOutputMessage) => void;
      onError?: (reason: string) => void;
    },
  ): () => void;

  /**
   * Follows one subagent's transcript. Opened on expand, closed on collapse, like task output.
   *
   * Separate from `subscribeTaskOutput` because a subagent has no output in that sense. What it
   * produces is a transcript of events, not bytes in a file, and the two cannot share a stream
   * without one of them pretending to be the other.
   *
   * `agentId` is also the task id of the row this is opened from -- the harness uses the same
   * string for both -- so a caller never has to correlate them.
   */
  subscribeSubagentTranscript(
    session: SessionReference,
    agentId: string,
    handlers: {
      onMessage: (message: SubagentTranscriptMessage) => void;
      onError?: (reason: string) => void;
    },
  ): () => void;

  /**
   * The newest message a person wrote in a Claude session, found across the whole transcript.
   *
   * Rejects when there is none. The user bar reads it for a message the feed has not paged back to,
   * with `said`, which passes over a message that only ran a slash command.
   */
  lastMessage(sessionId: string, options?: { said?: boolean }): Promise<LastSessionMessage>;
}
