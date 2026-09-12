// Reading one session's thread: its events, its background tasks, and the prompts it raises.
//
// The layer that carries the one thing this level genuinely does rather than forwards: the
// composite `/timeline` stream arrives as a single message type, and `deliver` is what turns it
// into the handler callbacks the viewer already speaks. Extension UI is here rather than in a
// file of its own because those events ride that same stream -- a prompt belongs to the session
// that asked it, and `deliver` is what hands it on.

import type {
  ActivityEvent,
  AgentUiEvent,
  BackgroundTaskSnapshot,
  EventsPage as WireEventsPage,
  TaskOutputMessage,
  TimelineMessage,
} from "@agentdesk/agent-feed-wire";
import type {
  AgentSessionState,
  EventsPage,
  SessionEventsHandlers,
  SessionReference,
} from "@/features/activity-feed/data-source/AgentDataSource";
import { parse, SidecarError, SidecarRoutes } from "@/features/activity-feed/data-source/sidecarRoutes";

function timelinePath(session: SessionReference): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/timeline?mode=${session.mode}`;
}

function tasksPath(session: SessionReference): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/tasks`;
}

function taskOutputPath(session: SessionReference, taskId: string): string {
  return `${tasksPath(session)}/${encodeURIComponent(taskId)}/output`;
}

function eventsPath(session: SessionReference, offset: number, limit: number): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/events?offset=${offset}&limit=${limit}&mode=${session.mode}`;
}

export class SidecarTranscript extends SidecarRoutes {
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

  /**
   * Follows the session's background tasks.
   *
   * The sidecar only sends when something actually changed, so this stream is quiet while one
   * long task runs. Elapsed time is re-derived on the client from `startedAt` for the same
   * reason -- a clock that ticked on the wire would defeat the suppression entirely.
   */
  subscribeBackgroundTasks(
    session: SessionReference,
    handlers: {
      onSnapshot: (snapshot: BackgroundTaskSnapshot) => void;
      onError?: (reason: string) => void;
    },
  ): () => void {
    return this.transport.subscribe(tasksPath(session), {
      onMessage: (payload) => handlers.onSnapshot(JSON.parse(payload) as BackgroundTaskSnapshot),
      onError: (reason) => handlers.onError?.(reason),
    });
  }

  /** Follows one task's output. Opened on expand, closed on collapse. */
  subscribeTaskOutput(
    session: SessionReference,
    taskId: string,
    handlers: {
      onMessage: (message: TaskOutputMessage) => void;
      onError?: (reason: string) => void;
    },
  ): () => void {
    return this.transport.subscribe(taskOutputPath(session, taskId), {
      onMessage: (payload) => handlers.onMessage(JSON.parse(payload) as TaskOutputMessage),
      onError: (reason) => handlers.onError?.(reason),
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
