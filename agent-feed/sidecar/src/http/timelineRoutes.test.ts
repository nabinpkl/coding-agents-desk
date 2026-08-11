import { afterEach, expect, test } from "bun:test";
import type { AgentBackend, AgentSessionDescriptor } from "../agents/agentBackend.ts";
import type {
  ActivityEvent,
  AgentSessionCapabilities,
  TimelineEnvelope,
  TimelineMessage,
} from "@agentdesk/agent-feed-wire";
import { state } from "../transcripts/transcriptState.ts";
import { createTimelineRoutes, TIMELINE_WINDOW } from "./timelineRoutes.ts";

const server = { timeout() {} } as never;

const PI_CAPABILITIES: AgentSessionCapabilities = {
  modes: ["nice"],
  canSend: true,
  canSteer: true,
  canAbort: true,
  canFetchRaw: false,
  canOpenTerminal: false,
  supportsExtensionUi: true,
  canStreamLive: false,
};

function event(index: number): ActivityEvent {
  return {
    id: `e${index}`,
    index,
    revision: 0,
    phase: "complete",
    ts: index,
    type: "assistant",
    blocks: [],
  };
}

interface Recorded {
  subscribeCalls: number[];
  uiCalls: number;
  stopped: string[];
}

function fakeBackend(total: number, recorded: Recorded): AgentBackend {
  return {
    id: "pi",
    capabilities: PI_CAPABILITIES,
    describeSession(sessionId): AgentSessionDescriptor {
      return {
        sessionId,
        source: "pi",
        projectPath: "/project",
        title: sessionId,
        lastEventAt: 0,
        activity: "ready",
        capabilities: PI_CAPABILITIES,
      };
    },
    async createSession() { throw new Error("not used"); },
    async page(_sessionId, offset, limit) {
      const end = Math.min(total, offset + limit);
      const events: ActivityEvent[] = [];
      for (let index = offset; index < end; index += 1) events.push(event(index));
      return { events, total, mode: "nice", sequence: total, runState: "idle", queue: { steer: 0, followUp: 0 } };
    },
    async subscribe(_sessionId, afterSequence) {
      recorded.subscribeCalls.push(afterSequence);
      return () => recorded.stopped.push("timeline");
    },
    async send(_sessionId, requestId) { return { requestId, delivery: "immediate" }; },
    async abort(_sessionId, requestId) { return { requestId, delivery: "abort" }; },
    async subscribeUi() {
      recorded.uiCalls += 1;
      return () => recorded.stopped.push("ui");
    },
    async respondToUi() { return "accepted"; },
    async dispose() {},
  };
}

function recorder(): Recorded {
  return { subscribeCalls: [], uiCalls: 0, stopped: [] };
}

function routesFor(backend: AgentBackend) {
  state.watcherState = "live";
  return createTimelineRoutes(
    (id) => (id === backend.id ? backend : undefined),
    (source, sessionId) => (source === backend.id ? backend.describeSession(sessionId) : undefined),
  );
}

afterEach(() => {
  state.watcherState = "idle";
});

/**
 * Reads SSE messages until `count` have arrived, leaving the stream open.
 *
 * The caller cancels, because cancelling IS leaving the thread: the route stops
 * opening streams the moment its subscriber is gone, so a helper that cancelled on
 * its own would be asserting against a torn-down subscription.
 */
async function readMessages(
  response: Response,
  count: number,
): Promise<{ messages: TimelineMessage[]; leave: () => Promise<void> }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const messages: TimelineMessage[] = [];
  let buffer = "";
  while (messages.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = frame.startsWith("data: ") ? frame.slice(6) : null;
      if (payload) messages.push(JSON.parse(payload) as TimelineMessage);
      boundary = buffer.indexOf("\n\n");
    }
  }
  return { messages, leave: () => reader.cancel() };
}

/** Opens a timeline stream and reads its opening messages. */
async function openTimeline(
  route: ReturnType<typeof routesFor>,
  query = "?mode=nice",
  count = 1,
): Promise<{ messages: TimelineMessage[]; leave: () => Promise<void> }> {
  const request = timelineRequest(query);
  const response = await route(request, new URL(request.url), server);
  const read = await readMessages(response as Response, count);
  // The snapshot resolves before the follow-on subscriptions are issued; give the
  // rest of the open a turn before asserting on what it opened.
  await Bun.sleep(5);
  return read;
}

/** The envelope of a timeline message, failing loudly on any other message type. */
function envelopeOf(message: TimelineMessage | undefined): TimelineEnvelope {
  if (!message || message.type !== "timeline") {
    throw new Error(`expected a timeline message, got ${JSON.stringify(message)}`);
  }
  return message.envelope;
}

function timelineRequest(query = "?mode=nice"): Request {
  return new Request(`http://localhost/api/sessions/pi/s1/timeline${query}`);
}

test("a thread opens at its end, not at its beginning", async () => {
  const recorded = recorder();
  const { messages, leave } = await openTimeline(routesFor(fakeBackend(250, recorded)));

  const envelope = envelopeOf(messages[0]);
  expect(envelope.kind).toBe("snapshot");
  expect(envelope.windowStart).toBe(250 - TIMELINE_WINDOW);
  expect(envelope.total).toBe(250);
  expect(envelope.events.length).toBe(TIMELINE_WINDOW);
  expect(envelope.events[0]!.index).toBe(150);
  await leave();
});

test("a session shorter than the window opens at zero with everything it has", async () => {
  const recorded = recorder();
  const { messages, leave } = await openTimeline(routesFor(fakeBackend(3, recorded)));

  const envelope = envelopeOf(messages[0]);
  expect(envelope.windowStart).toBe(0);
  expect(envelope.events.length).toBe(3);
  await leave();
});

test("the live stream is followed from the snapshot's sequence, so no row is sent twice", async () => {
  const recorded = recorder();
  const { leave } = await openTimeline(routesFor(fakeBackend(250, recorded)));

  expect(recorded.subscribeCalls).toEqual([250]);
  await leave();
});

test("extension UI opens for a session that serves it", async () => {
  const recorded = recorder();
  const { leave } = await openTimeline(routesFor(fakeBackend(1, recorded)));

  expect(recorded.uiCalls).toBe(1);
  await leave();
});

test("a session that serves no extension UI opens no UI stream", async () => {
  const recorded = recorder();
  const backend = fakeBackend(1, recorded);
  const capabilities = { ...PI_CAPABILITIES, supportsExtensionUi: false };
  backend.describeSession = (sessionId) => ({
    sessionId,
    source: "pi",
    projectPath: "/project",
    title: sessionId,
    lastEventAt: 0,
    activity: "ready",
    capabilities,
  });
  const { leave } = await openTimeline(routesFor(backend));

  expect(recorded.uiCalls).toBe(0);
  await leave();
});

test("leaving the thread tears down every stream it opened", async () => {
  const recorded = recorder();
  const { leave } = await openTimeline(routesFor(fakeBackend(1, recorded)));
  await leave();
  await Bun.sleep(5);

  expect(recorded.stopped.sort()).toEqual(["timeline", "ui"]);
});

test("mode is required rather than guessed", async () => {
  const recorded = recorder();
  const route = routesFor(fakeBackend(1, recorded));
  const request = timelineRequest("");
  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(400);
  expect(await response?.json()).toMatchObject({ error: { code: "invalid-mode" } });
});

test("a mode the session does not serve is refused, not renumbered", async () => {
  const recorded = recorder();
  const route = routesFor(fakeBackend(1, recorded));
  const request = timelineRequest("?mode=raw");
  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(400);
  expect(await response?.json()).toMatchObject({ error: { code: "unsupported-mode" } });
});

test("an unknown source is a 404 rather than an empty stream", async () => {
  const recorded = recorder();
  const route = routesFor(fakeBackend(1, recorded));
  const request = new Request("http://localhost/api/sessions/nope/s1/timeline?mode=nice");
  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(404);
});

test("the inventory answers 503 while it is still starting", async () => {
  const recorded = recorder();
  const route = routesFor(fakeBackend(1, recorded));
  state.watcherState = "reconciling";
  const request = timelineRequest();
  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(503);
});
