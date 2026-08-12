// The composite thread subscription: one stream that carries everything opening a
// thread needs.
//
// Opening a thread used to be four coordinated requests made by whoever held the
// connection -- probe the page count, fetch the last window, follow the durable
// stream from that window's sequence, and open the live-tail and extension-UI
// streams when the session's capabilities warranted them -- plus the bookkeeping to
// stop believing a subscription the viewer had already moved on from. Every one of
// those decisions is the sidecar's own knowledge: its window size, its sequence
// numbering, its capability table. So it is made here, once, and a subscriber opens
// one stream and reads messages off it.

import type { AgentBackend } from "../agents/agentBackend.ts";
import {
  findSession,
  getWatcherState,
  sessionCapabilities,
  type AgentSessionDescriptorResolver,
} from "../transcripts/transcriptCatalog.ts";
import type {
  EventMode,
  SourceId,
  TokenUsage,
  TranscriptSourceId,
} from "../transcripts/sources/transcriptTypes.ts";
import type { EventsPage, TimelineMessage } from "@agentdesk/agent-feed-wire";
import { encodeServerSentEvent, jsonResponse, startServerSentEventStream } from "./httpResponses.ts";
import { readTranscriptPage, subscribeTranscriptTimeline } from "./sessionRoutes.ts";
import type { RouteHandler } from "./route.ts";

const TIMELINE_ROUTE =
  /^\/api\/sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/timeline$/;

/**
 * How many of a session's most recent events the opening snapshot carries.
 *
 * A thread opens at its end, so the window is the tail of the transcript and
 * everything before it is paged in on demand.
 */
export const TIMELINE_WINDOW = 100;

/** A live backend additionally publishes session occupancy; most do not. */
type UsageReportingBackend = AgentBackend & { sessionUsage(sessionId: string): TokenUsage | null };

function backendUsage(backend: AgentBackend, sessionId: string): TokenUsage | null {
  const reporting = backend as UsageReportingBackend;
  return typeof reporting.sessionUsage === "function" ? reporting.sessionUsage(sessionId) : null;
}

/**
 * The source's transcript adapter, or null when it has none.
 *
 * Having a catalog entry is NOT the test: a Pi session is in the catalog too, and
 * its record points at a file the transcript index cannot read. Only the two sources
 * with adapters are durable on disk; everything else is durable in its backend.
 */
function transcriptSource(source: string): TranscriptSourceId | null {
  return source === "claude" || source === "codex" ? source : null;
}

// Required rather than defaulted. The two paths this endpoint replaced disagreed
// about the default -- transcripts answered `raw`, agent sessions `nice` -- and a
// composite stream that picked one of them would silently answer half its callers
// in the other view, with every index off by the machinery lines between them.
function modeQuery(url: URL): EventMode | null {
  const raw = url.searchParams.get("mode");
  return raw === "raw" || raw === "nice" ? raw : null;
}

export function createTimelineRoutes(
  resolveBackend: (id: string) => AgentBackend | undefined,
  resolveAgentSession: AgentSessionDescriptorResolver,
): RouteHandler {
  return (request, url, server) => {
    if (request.method !== "GET") return undefined;
    const match = TIMELINE_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    if (getWatcherState() !== "live") {
      return errorResponse("inventory-not-ready", "session inventory is still starting", 503);
    }
    const source = match[1]! as SourceId;
    const sessionId = match[2]!;
    const mode = modeQuery(url);
    if (mode === null) {
      return errorResponse("invalid-mode", "mode must be raw or nice", 400);
    }

    // A transcript on disk is the durable record; an agent backend is the durable
    // record when there is no transcript. Which one answers decides how the window
    // is read and how it is followed, and nothing below has to ask again.
    const adapter = transcriptSource(source);
    const transcript = adapter && findSession(adapter, sessionId) ? adapter : null;
    const backend = resolveBackend(source);
    if (!transcript && !backend) {
      return errorResponse("session-not-found", `no session ${source}/${sessionId}`, 404);
    }

    const capabilities = sessionCapabilities(source, sessionId, resolveAgentSession);
    if (!capabilities.modes.includes(mode)) {
      return errorResponse(
        "unsupported-mode",
        `session ${source}/${sessionId} does not serve ${mode} mode`,
        400,
      );
    }

    return timelineStream({
      request,
      server,
      source,
      sessionId,
      mode,
      backend,
      transcript,
      streamsLive: capabilities.canStreamLive,
      servesExtensionUi: capabilities.supportsExtensionUi,
    });
  };
}

function timelineStream(options: {
  request: Request;
  server: Parameters<RouteHandler>[2];
  source: SourceId;
  sessionId: string;
  mode: EventMode;
  backend: AgentBackend | undefined;
  /** The transcript adapter that owns this session's durable record, if any. */
  transcript: TranscriptSourceId | null;
  streamsLive: boolean;
  servesExtensionUi: boolean;
}): Response {
  const { source, sessionId, mode, backend, transcript } = options;
  return startServerSentEventStream(options.request, options.server, (write) => {
    let cancelled = false;
    const teardowns: Array<() => void> = [];
    const emit = (message: TimelineMessage): void => {
      if (cancelled) return;
      write(encodeServerSentEvent(message));
    };
    const fail = (code: string, error: unknown, retryable = true): void => {
      emit({
        type: "error",
        error: { code, message: error instanceof Error ? error.message : String(error), retryable },
      });
    };
    // A teardown that arrives after the subscriber left runs immediately: an async
    // open that lands on a closed stream must not leave a watcher or a backend
    // subscription behind.
    const hold = (stop: (() => void) | null | undefined): void => {
      if (!stop) return;
      if (cancelled) stop();
      else teardowns.push(stop);
    };

    void (async () => {
      const window = await openingWindow(sessionId, mode, backend, transcript);
      if (cancelled) return;
      if (!window) {
        fail("session-not-found", `no session ${source}/${sessionId}`, false);
        return;
      }
      emit({
        type: "timeline",
        envelope: {
          kind: "snapshot",
          sequence: window.page.sequence,
          mode: window.page.mode,
          events: window.page.events,
          windowStart: window.windowStart,
          total: window.page.total,
          runState: window.page.runState,
          queue: window.page.queue,
          usage: window.page.usage,
        },
      });
      if (cancelled) return;

      // Followed from the window's own sequence rather than from zero, so the
      // stream resumes exactly where the snapshot ended with no gap to reconcile
      // and no rows delivered twice.
      if (transcript) {
        hold(subscribeTranscriptTimeline(transcript, sessionId, window.page.sequence, mode, {
          onEnvelope: (envelope) => emit({ type: "timeline", envelope }),
          onError: (message) => fail("timeline-stream-failed", message),
        }));
      } else if (backend) {
        hold(
          await backend
            .subscribe(sessionId, window.page.sequence, (envelope) =>
              emit({ type: "timeline", envelope }))
            .catch((error) => {
              fail("timeline-stream-failed", error);
              return null;
            }),
        );
      }
      if (cancelled) return;

      // The live tail is a second view of a session the transcript already carries:
      // the mirror shows the message while it is being written, the transcript shows
      // it once it lands. Only a session whose backend advertises canStreamLive has
      // one, so this is a capability check rather than a source check.
      if (options.streamsLive && backend) {
        // The tail is ONE row -- the message being written -- but it is drawn from a
        // projection that is a whole live timeline, and its envelopes carry more than
        // this slot can hold.
        //
        // A state-only envelope (a run-state or queue change) has no events at all,
        // and forwarding its missing first event as `null` blanked the message
        // mid-write every time the queue moved.
        //
        // And the projection keeps revising rows the newest one has already replaced:
        // a turn's tool results are their own row, published when the follow-up
        // request carries them, so a completed result row would arrive AFTER the next
        // message had started streaming and take the slot back from it. On screen that
        // was a loose RESULT block appearing under the message being written, then
        // vanishing when the next delta arrived. Those rows are not lost by staying
        // out of the tail: the transcript stream above already carries them, in order
        // and paired with the call that produced them, and for a session with no
        // transcript the projection reaches the viewer through that same stream.
        let newestIndex = -1;
        hold(
          await backend
            .subscribe(sessionId, 0, (envelope) => {
              // The LAST row, not the first. A live upsert carries exactly one either
              // way, but the subscription opens by replaying what the projection
              // already holds, and reading that window's first row put the oldest
              // message in the slot on every open.
              const event = envelope.events.at(-1);
              if (!event || event.index < newestIndex) return;
              newestIndex = event.index;
              emit({ type: "tail", event: { ...event, otherModeIndex: event.index } });
            })
            .catch(() => {
              // The mirror going away is not the thread failing: clear the tail so
              // no half-written message is left on screen, and keep the durable
              // stream running.
              emit({ type: "tail", event: null });
              return null;
            }),
        );
      }
      if (cancelled) return;

      if (options.servesExtensionUi && backend) {
        hold(
          await backend
            .subscribeUi(sessionId, (event) => emit({ type: "ui", event }))
            .catch((error) => {
              fail("ui-stream-failed", error);
              return null;
            }),
        );
      }
    })().catch((error) => fail("timeline-open-failed", error));

    return () => {
      cancelled = true;
      for (const stop of teardowns) stop();
      teardowns.length = 0;
    };
  });
}

/**
 * The last `TIMELINE_WINDOW` events of a session, and where in the session they
 * start. Null when the session cannot be read at all.
 *
 * Two reads rather than one: the first is a probe for the count, which is what says
 * where the window begins. A session shorter than the window starts at 0 and the
 * probe already answered it.
 */
async function openingWindow(
  sessionId: string,
  mode: EventMode,
  backend: AgentBackend | undefined,
  transcript: TranscriptSourceId | null,
): Promise<{ page: EventsPage; windowStart: number } | null> {
  const read = async (offset: number, limit: number): Promise<EventsPage | null> => {
    if (transcript) {
      return readTranscriptPage(transcript, sessionId, offset, limit, mode);
    }
    if (!backend) return null;
    const page = await backend.page(sessionId, offset, limit, mode);
    return { ...page, usage: backendUsage(backend, sessionId) };
  };

  const probe = await read(0, 1);
  if (!probe) return null;
  const windowStart = Math.max(0, probe.total - TIMELINE_WINDOW);
  if (windowStart >= probe.total) return { page: { ...probe, events: [] }, windowStart };
  const page = await read(windowStart, probe.total - windowStart);
  if (!page) return null;
  return { page, windowStart };
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message, retryable: status >= 500 } }, status);
}
