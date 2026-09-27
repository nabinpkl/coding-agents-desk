// Reading one session's thread: its events, its background tasks, and the prompts it raises.
//
// The layer that carries the one thing this level genuinely does rather than forwards: the
// composite `/timeline` stream arrives as a single message type, and `deliver` is what turns it
// into the handler callbacks the viewer already speaks. Extension UI is here rather than in a
// file of its own because those events ride that same stream -- a prompt belongs to the session
// that asked it, and `deliver` is what hands it on.

import {
  TIMELINE_HEARTBEAT_MS,
  type ActivityEvent,
  type AgentUiEvent,
  type BackgroundTaskSnapshot,
  type EventsPage as WireEventsPage,
  type SubagentTranscriptMessage,
  type TaskOutputMessage,
  type TimelineMessage,
} from "@agentdesk/agent-feed-wire";
import type {
  AgentSessionState,
  EventsPage,
  SessionEventsHandlers,
  SessionReference,
} from "@/features/activity-feed/data-source/AgentDataSource";
import { parse, SidecarError, SidecarRoutes } from "@/features/activity-feed/data-source/sidecarRoutes";

/** Three missed heartbeats: one late beat is jitter, three is a connection that stopped. */
const TIMELINE_STALL_MS = TIMELINE_HEARTBEAT_MS * 3;

function timelinePath(session: SessionReference): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/timeline?mode=${session.mode}`;
}

function tasksPath(session: SessionReference): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/tasks`;
}

function taskOutputPath(session: SessionReference, taskId: string): string {
  return `${tasksPath(session)}/${encodeURIComponent(taskId)}/output`;
}

// Under the session rather than beside it, because a subagent belongs to the session that
// launched it: its transcript is only addressable through that pair, never by agent id alone.
function subagentTranscriptPath(session: SessionReference, agentId: string): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/` +
    `${encodeURIComponent(session.sessionId)}/agents/${encodeURIComponent(agentId)}/transcript`;
}

function eventsPath(session: SessionReference, offset: number, limit: number): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/events?offset=${offset}&limit=${limit}&mode=${session.mode}`;
}

/**
 * What a compaction message leaves on screen: the summary written so far, or null when nothing is
 * being compacted.
 *
 * Folded here rather than in the viewer because the stream sends the summary as appends, and this
 * is the one layer that sees every message of the stream in order.
 */
function nextCompaction(
  current: string | null,
  message: Extract<TimelineMessage, { type: "compacting" | "compaction-summary" }>,
): string | null {
  if (message.type === "compacting") return message.active ? (message.summary ?? "") : null;
  // More of a compaction this stream never heard start is not one to show.
  if (current === null) return null;
  return message.replace ? message.text : current + message.text;
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
    return { events: page.events, total: page.total, usage: page.usage ?? null, sessionModel: page.sessionModel ?? null };
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
    const path = timelinePath(session);
    let heardAt = Date.now();
    let compaction: string | null = null;
    const open = (): (() => void) =>
      this.transport.subscribe(path, {
        onOpen: () => {
          heardAt = Date.now();
          // An opening stream says afresh whether a compaction is running, so one that ended while
          // the connection was down must not stay on screen.
          if (compaction !== null) {
            compaction = null;
            handlers.onCompacting?.(null);
          }
          handlers.onOpen?.();
        },
        onMessage: (payload) => {
          heardAt = Date.now();
          const message = JSON.parse(payload) as TimelineMessage;
          if (message.type === "compacting" || message.type === "compaction-summary") {
            compaction = nextCompaction(compaction, message);
            handlers.onCompacting?.(compaction);
            return;
          }
          this.deliver(message, handlers);
        },
        // An error before the stream ever opened and one after it was running are the same thing
        // to the viewer: the thread is not live and it should say so.
        onError: () => handlers.onError?.(),
      });
    let close = open();
    // A connection that stops delivering without closing raises nothing: `EventSource` reconnects
    // only on an error or an end, and a stalled proxy or a path that changed under a sleeping
    // laptop produces neither. The thread then sat still while its agent kept working, until a
    // reload. The sidecar sends a heartbeat, so silence past a few beats is the stall itself, and
    // reopening is the repair: the new stream opens with a snapshot of the newest window, which
    // carries what the dead one held back as long as that is under a window's worth.
    //
    // Checked on the beat rather than armed per message, so a busy stream costs a timestamp write
    // and nothing else. A throttled background tab checks late, which only delays the repair.
    const watchdog = setInterval(() => {
      const silentFor = Date.now() - heardAt;
      if (silentFor < TIMELINE_STALL_MS) return;
      console.warn(`[timeline] ${path} silent for ${Math.round(silentFor / 1000)}s, reopening`);
      close();
      handlers.onError?.();
      heardAt = Date.now();
      close = open();
    }, TIMELINE_HEARTBEAT_MS);
    return () => {
      clearInterval(watchdog);
      close();
    };
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

  /** Follows one subagent's transcript. Opened on expand, closed on collapse. */
  subscribeSubagentTranscript(
    session: SessionReference,
    agentId: string,
    handlers: {
      onMessage: (message: SubagentTranscriptMessage) => void;
      onError?: (reason: string) => void;
    },
  ): () => void {
    return this.transport.subscribe(subagentTranscriptPath(session, agentId), {
      onMessage: (payload) => handlers.onMessage(JSON.parse(payload) as SubagentTranscriptMessage),
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
        // The model rides beside usage for the same reason, and lands the same way: it is
        // what keeps the switcher named across the post-compaction gap that blanks usage.
        if (envelope.sessionModel !== undefined) handlers.onSessionModel?.(envelope.sessionModel ?? null);
        if (envelope.kind === "snapshot") {
          handlers.onSnapshot({
            events: envelope.events,
            total: envelope.total,
            usage: envelope.usage ?? null,
            sessionModel: envelope.sessionModel ?? null,
            windowStart: envelope.windowStart ?? 0,
            stableIndices: envelope.stableIndices,
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
      case "heartbeat":
        // Already counted: arriving at all is what it is for.
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

  /**
   * An address rather than a fetch, because the answer is the image's own bytes and this
   * transport's responses are text. The browser loads it, and caches it by that address.
   */
  eventImageUrl(session: SessionReference, eventIndex: number, blockIndex: number): string | null {
    return this.transport.resourceUrl?.(
      `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/events/${eventIndex}/blocks/${blockIndex}/image?mode=${session.mode}`,
    ) ?? null;
  }

  /** The same address for a file the call handed over, named by its place in that call's list. */
  eventFileUrl(
    session: SessionReference,
    eventIndex: number,
    blockIndex: number,
    fileIndex: number,
  ): string | null {
    return this.transport.resourceUrl?.(
      `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/events/${eventIndex}/blocks/${blockIndex}/files/${fileIndex}?mode=${session.mode}`,
    ) ?? null;
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
