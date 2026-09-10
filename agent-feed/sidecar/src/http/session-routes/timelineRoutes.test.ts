import { afterEach, expect, test } from "bun:test";
import type { AgentBackend, AgentSessionDescriptor } from "@/agents/agentBackend";
import type {
  ActivityEvent,
  AgentSessionCapabilities,
  TimelineEnvelope,
  TimelineMessage,
} from "@agentdesk/agent-feed-wire";
import { state } from "@/transcripts/transcriptState";
import { createTimelineRoutes, TIMELINE_WINDOW } from "@/http/session-routes/timelineRoutes";

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

test("a backend-backed thread does not claim its indices are stable", async () => {
  // Pi is durable in its backend rather than on disk, and that projection renumbers,
  // so a reader must drop whatever it paged in when the window is re-sent. The panel
  // reads this flag and nothing else to decide that, so a backend session answering
  // `true` here would silently merge one session's indices into another's.
  const recorded = recorder();
  const { messages, leave } = await openTimeline(routesFor(fakeBackend(250, recorded)));

  expect(envelopeOf(messages[0]).stableIndices).toBe(false);
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

/**
 * A backend that streams live, handing the test the projection listener the tail
 * subscribes with so it can publish the envelope sequence a real turn produces.
 */
function liveBackend(recorded: Recorded): {
  backend: AgentBackend;
  publish: (envelope: TimelineEnvelope) => void;
} {
  const backend = fakeBackend(1, recorded);
  const capabilities = { ...PI_CAPABILITIES, canStreamLive: true };
  backend.describeSession = (sessionId) => ({
    sessionId,
    source: "pi",
    projectPath: "/project",
    title: sessionId,
    lastEventAt: 0,
    activity: "ready",
    capabilities,
  });
  let listener: ((envelope: TimelineEnvelope) => void) | null = null;
  backend.subscribe = async (_sessionId, afterSequence, onEnvelope) => {
    recorded.subscribeCalls.push(afterSequence);
    // The tail is the subscription that starts at zero; the timeline one resumes from
    // the snapshot's sequence and must not be mistaken for it.
    if (afterSequence === 0) listener = onEnvelope;
    return () => recorded.stopped.push("timeline");
  };
  return { backend, publish: (envelope) => listener?.(envelope) };
}

function liveEnvelope(events: ActivityEvent[], sequence: number): TimelineEnvelope {
  return {
    kind: events.length === 0 ? "state" : "upsert",
    sequence,
    mode: "nice",
    events,
    windowStart: events[0]?.index ?? 0,
    total: 1,
    runState: "running",
    queue: { steer: 0, followUp: 0 },
  };
}

function liveRow(index: number, type: ActivityEvent["type"], phase: ActivityEvent["phase"]): ActivityEvent {
  return { id: `live-${index}`, index, revision: 0, phase, ts: index, type, blocks: [] };
}

/** Every tail event a stream emitted, in order, `null` included. */
function tailEvents(messages: TimelineMessage[]): Array<number | null> {
  return messages
    .filter((message) => message.type === "tail")
    .map((message) => (message.type === "tail" ? (message.event?.index ?? null) : null));
}

test("a mirror that arrives after the stream opened still gets a tail, with no reload", async () => {
  // The capability was read once, when the request arrived, so a stream that opened without it
  // never asked again. A live mirror coming up late -- the observer process starting, or the
  // backend acquiring a projection for this session the first time its traffic passes through --
  // was therefore invisible to every thread already on screen, and `EventSource` does not rescue
  // it: it reopens only when the server closes or the connection errors, and a healthy stream
  // does neither. The thread stayed half-live until somebody reloaded the panel.
  const recorded = recorder();
  const { backend, publish } = liveBackend(recorded);
  // The BACKEND can stream live; this SESSION has no projection in it yet. That gap is the whole
  // case: a per-session capability that turns on after the stream opened.
  const offline = { ...PI_CAPABILITIES, canStreamLive: false };
  let live = false;
  backend.describeSession = (sessionId) => ({
    sessionId,
    source: "pi",
    projectPath: "/project",
    title: sessionId,
    lastEventAt: 0,
    activity: "ready",
    capabilities: live ? { ...PI_CAPABILITIES, canStreamLive: true } : offline,
  });
  // The announcement the real backends make from `ensureProjection`.
  const announce = new Set<(sessionId: string) => void>();
  (backend as unknown as {
    onSessionLive(listener: (sessionId: string) => void): () => void;
  }).onSessionLive = (listener) => {
    announce.add(listener);
    return () => announce.delete(listener);
  };

  const request = timelineRequest();
  const response = (await routesFor(backend)(request, new URL(request.url), server)) as Response;
  const reader = readMessages(response, 2);
  await Bun.sleep(5);
  // The tail is the subscription that starts at zero. Nothing has one yet.
  expect(recorded.subscribeCalls).not.toContain(0);

  live = true;
  for (const listener of announce) listener("s1");
  await Bun.sleep(5);
  expect(recorded.subscribeCalls).toContain(0);

  publish(liveEnvelope([liveRow(4, "assistant", "streaming")], 1));
  const { messages, leave } = await reader;

  expect(tailEvents(messages)).toEqual([4]);
  await leave();
});

test("opening the tail lands on the newest row the projection holds, not its oldest", async () => {
  // The subscription opens by replaying what the projection already has, as one
  // envelope carrying a window of rows. Reading its first row put a message that had
  // already landed into the slot and left it there until the next delta.
  const recorded = recorder();
  const { backend, publish } = liveBackend(recorded);
  const request = timelineRequest();
  const response = (await routesFor(backend)(request, new URL(request.url), server)) as Response;
  const reader = readMessages(response, 2);
  await Bun.sleep(5);

  publish(
    liveEnvelope(
      [liveRow(3, "assistant", "complete"), liveRow(4, "assistant", "streaming")],
      1,
    ),
  );
  const { messages, leave } = await reader;

  expect(tailEvents(messages)).toEqual([4]);
  await leave();
});

test("a run-state change does not blank the message being written", async () => {
  // The projection publishes state changes as envelopes with no events at all. Reading
  // their missing first event as "no tail" cleared the row mid-write on every queue move.
  const recorded = recorder();
  const { backend, publish } = liveBackend(recorded);
  const request = timelineRequest();
  const response = (await routesFor(backend)(request, new URL(request.url), server)) as Response;
  // Three messages: the snapshot and two tails. A state envelope between them must not
  // become a third tail, so the run that still carries the bug reads `[7, null]` here
  // rather than hanging.
  const reader = readMessages(response, 3);
  await Bun.sleep(5);

  publish(liveEnvelope([liveRow(7, "assistant", "streaming")], 1));
  publish(liveEnvelope([], 2));
  publish(liveEnvelope([{ ...liveRow(7, "assistant", "streaming"), revision: 1 }], 3));
  const { messages, leave } = await reader;

  expect(tailEvents(messages)).toEqual([7, 7]);
  await leave();
});

test("a tool result revised after the next message started does not take the tail back", async () => {
  // The shape a real turn produces: the turn's tool results are their own projection
  // row, published from the follow-up request body, so a completed result row is still
  // being revised after the next message has started streaming. Forwarding that
  // revision put a loose RESULT block under the message being written, which then
  // vanished on the next delta.
  const recorded = recorder();
  const { backend, publish } = liveBackend(recorded);
  const request = timelineRequest();
  const response = (await routesFor(backend)(request, new URL(request.url), server)) as Response;
  // The snapshot plus the three tails a correct run emits; the run that carries the bug
  // emits four and still resolves, on `[8, 9, 8]`.
  const reader = readMessages(response, 4);
  await Bun.sleep(5);

  publish(liveEnvelope([liveRow(8, "user", "complete")], 1));
  publish(liveEnvelope([liveRow(9, "assistant", "streaming")], 2));
  publish(liveEnvelope([{ ...liveRow(8, "user", "complete"), revision: 1 }], 3));
  publish(liveEnvelope([{ ...liveRow(9, "assistant", "streaming"), revision: 1 }], 4));
  const { messages, leave } = await reader;

  expect(tailEvents(messages)).toEqual([8, 9, 9]);
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
