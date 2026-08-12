/**
 * The panel's view of the agent-feed sidecar: its routes, called directly.
 *
 * What this replaces is worth stating, because the size difference is the point. The bridge data
 * source was ~1,800 lines, and almost none of it was about the feed. It was request/response
 * correlation, per-type subscription bookkeeping, buffered page reassembly, and timeout handling
 * -- machinery the typed message protocol needed because it had no notion of a request that gets
 * an answer. HTTP has one, so it is gone.
 *
 * What is left is a call per sidecar route, plus one thing that genuinely is this layer's job:
 * turning the composite `/timeline` stream into the handler callbacks the viewer already speaks.
 */

import type {
  ActivityEvent,
  AgentCommandReceipt,
  AgentSessionDescriptor,
  AgentUiEvent,
  EventsPage as WireEventsPage,
  ProjectSummary,
  SessionSummary,
  TimelineMessage,
  TokenUsage,
} from "@agentdesk/agent-feed-wire";
import type {
  AgentDataSource,
  AgentSessionState,
  EventsPage,
  SessionEventsHandlers,
  SessionReference,
} from "./AgentDataSource";
import type { AgentHttpTransport } from "../transport/AgentHttpTransport";

/** Thrown when the sidecar answered, but with an error rather than the thing asked for. */
export class SidecarError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SidecarError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Parses a response body, or throws.
 *
 * A non-2xx carries a `{ error: { code, message } }` body the panel can act on -- an unsupported
 * mode reads differently from a session that is gone -- so the code is preserved rather than
 * flattened into a generic failure.
 */
function parse<T>(response: { status: number; body: string }): T {
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new SidecarError("malformed-response", "sidecar response was not JSON", response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    const error = (payload as { error?: { code?: string; message?: string } }).error;
    throw new SidecarError(
      error?.code ?? "sidecar-error",
      error?.message ?? `sidecar answered ${response.status}`,
      response.status,
    );
  }
  return payload as T;
}

function timelinePath(session: SessionReference): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/timeline?mode=${session.mode}`;
}

function eventsPath(session: SessionReference, offset: number, limit: number): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/events?offset=${offset}&limit=${limit}&mode=${session.mode}`;
}

/**
 * Enough of a session to name it in a URL.
 *
 * Commands take this rather than a full `SessionReference` because a command is not read in a
 * mode: aborting a run or answering a prompt means the same thing whichever view of the
 * transcript is on screen, and requiring the mode would invite a caller to invent one.
 */
export interface SessionAddress {
  source: string;
  sessionId: string;
}

/** The panel's data source when there is a sidecar behind the transport, which is always. */
export class SidecarDataSource implements AgentDataSource {
  constructor(private readonly transport: AgentHttpTransport) {}

  // ---------------------------------------------------------------------
  // Inventory
  // ---------------------------------------------------------------------

  /**
   * Follows the project list, and the session list of every project in `projectPaths`.
   * Returns unsubscribe.
   *
   * One subscription for the whole sidebar, not one per project. The host relay admits
   * a bounded number of concurrent subscriptions per surface, and the per-project
   * streams spent that budget on connections that all carried the same catalog: a
   * fourth expanded project used to exhaust it, and the refusal landed on whichever
   * request asked next.
   *
   * Changing which projects are open means resubscribing, which is why the caller
   * passes the whole set rather than adding to it: the sidecar reads the set when the
   * stream opens, and one stream reopening costs one slot, never two.
   */
  subscribeInventory(
    projectPaths: readonly string[],
    handlers: {
      onProjects: (projects: ProjectSummary[]) => void;
      onSessions: (projectPath: string, sessions: SessionSummary[]) => void;
    },
    onError?: (reason: string) => void,
  ): () => void {
    const query = projectPaths
      .map((path) => `projectPath=${encodeURIComponent(path)}`)
      .join("&");
    return this.transport.subscribe(
      query ? `/api/inventory/stream?${query}` : "/api/inventory/stream",
      {
        onMessage: (payload) => {
          const message = JSON.parse(payload) as {
            projects?: ProjectSummary[];
            projectPath?: string;
            sessions?: SessionSummary[];
          };
          if (message.projects) handlers.onProjects(message.projects);
          else if (message.projectPath && message.sessions) {
            handlers.onSessions(message.projectPath, message.sessions);
          }
        },
        onError: (reason) => onError?.(reason),
      },
    );
  }

  // ---------------------------------------------------------------------
  // Transcript
  // ---------------------------------------------------------------------

  async fetchEventsPage(
    session: SessionReference,
    offset: number,
    limit: number,
  ): Promise<EventsPage> {
    const page = parse<WireEventsPage>(
      await this.transport.request("GET", eventsPath(session, offset, limit)),
    );
    return { events: page.events, total: page.total, usage: page.usage ?? null };
  }

  /**
   * Opens a thread.
   *
   * One stream, not four. The sidecar decides where the opening window starts, follows the
   * durable record from that window's own sequence so no row arrives twice, and opens the live
   * tail and extension UI only for a session whose capabilities warrant them. All of that used to
   * be orchestrated by whoever held the connection, from a capability table it kept a copy of.
   */
  subscribeSessionEvents(
    session: SessionReference,
    _after: number,
    handlers: SessionEventsHandlers,
  ): () => void {
    return this.transport.subscribe(timelinePath(session), {
      onOpen: () => handlers.onOpen?.(),
      onMessage: (payload) => {
        const message = JSON.parse(payload) as TimelineMessage;
        this.deliver(message, handlers);
      },
      // An error before the stream ever opened and one after it was running are the same thing to
      // the viewer: the thread is not live and it should say so.
      onError: () => handlers.onError?.(),
    });
  }

  private deliver(message: TimelineMessage, handlers: SessionEventsHandlers): void {
    switch (message.type) {
      case "timeline": {
        const envelope = message.envelope;
        const state: AgentSessionState = {
          sequence: envelope.sequence,
          runState: envelope.runState ?? "idle",
          queue: envelope.queue ?? { steer: 0, followUp: 0 },
        };
        handlers.onState?.(state);
        // Usage rides the envelope rather than its own message, and has to land whether the
        // envelope is the opening snapshot or a later chunk.
        if (envelope.usage !== undefined) handlers.onUsage?.(envelope.usage ?? null);
        if (envelope.kind === "snapshot") {
          handlers.onSnapshot({
            events: envelope.events,
            total: envelope.total,
            usage: envelope.usage ?? null,
            windowStart: envelope.windowStart ?? 0,
            state,
          });
          return;
        }
        for (const event of envelope.events) handlers.onEvent(event);
        return;
      }
      case "tail":
        handlers.onLiveTail?.(message.event);
        return;
      case "ui":
        this.uiListeners.forEach((listener) => listener(message.event));
        return;
      case "error":
        handlers.onError?.();
        return;
    }
  }

  /**
   * The exact original transcript line for one visible event.
   *
   * Plain text, not JSON: the whole promise of this view is that it shows the file's bytes, and
   * re-encoding them as a JSON string to decode them again is a chance to change them.
   */
  async fetchRawEvent(session: SessionReference, eventIndex: number): Promise<string> {
    const response = await this.transport.request(
      "GET",
      `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/events/${eventIndex}/raw?mode=${session.mode}`,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new SidecarError("raw-event-failed", `sidecar answered ${response.status}`, response.status);
    }
    return response.body;
  }

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------

  /**
   * Creates a session and answers with its descriptor, not a receipt.
   *
   * The caller opens the thread it just made, so a request id it would have to correlate against
   * a later list refresh would be a race it has no way to win.
   */
  async createSession(projectPath: string, source = "pi"): Promise<AgentSessionDescriptor> {
    return parse<AgentSessionDescriptor>(
      await this.transport.request("POST", "/api/agent-sessions", {
        body: { source, projectPath },
      }),
    );
  }

  async sendMessage(
    session: SessionAddress,
    text: string,
    delivery: "next" | "steer",
  ): Promise<AgentCommandReceipt> {
    return parse<AgentCommandReceipt>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/messages`,
        { body: { text, delivery } },
      ),
    );
  }

  async abortSession(session: SessionAddress): Promise<AgentCommandReceipt> {
    return parse<AgentCommandReceipt>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/abort`,
        { body: {} },
      ),
    );
  }

  async respondToExtensionUI(
    session: SessionAddress,
    requestId: string,
    value: unknown,
  ): Promise<void> {
    parse<unknown>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/ui/${encodeURIComponent(requestId)}`,
        { body: { value } },
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Extension UI
  // ---------------------------------------------------------------------

  private readonly uiListeners = new Set<(event: AgentUiEvent) => void>();

  /**
   * Listens for extension-UI events on whichever thread is open.
   *
   * They arrive on the thread's own stream rather than a separate subscription, because a prompt
   * belongs to the session that asked it: a second stream keyed by session id could outlive the
   * thread and answer for one the viewer had already left.
   */
  subscribeExtensionUI(listener: (event: AgentUiEvent) => void): () => void {
    this.uiListeners.add(listener);
    return () => {
      this.uiListeners.delete(listener);
    };
  }
}

export type { ActivityEvent, ProjectSummary, SessionSummary, TokenUsage };
