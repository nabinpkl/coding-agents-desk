/**
 * What the data source owns: the sidecar's routes, and turning one timeline stream into the
 * handler callbacks the viewer speaks.
 *
 * Everything it used to own besides that -- correlation, buffering, capability-driven fan-out of
 * four coordinated subscriptions -- moved to the transport below it and the sidecar above it, so
 * there is nothing here to test but the calls themselves and the one translation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SidecarDataSource, SidecarError } from "@/features/activity-feed/data-source/SidecarDataSource";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import type { SessionEventsHandlers } from "@/features/activity-feed/data-source/AgentDataSource";

const SESSION = { source: "claude", sessionId: "sid-1", mode: "nice" as const };

interface Recorder extends SessionEventsHandlers {
  snapshots: unknown[];
  events: unknown[];
  usages: unknown[];
  tails: unknown[];
  errors: string[];
}

function handlers(): Recorder {
  const sink: Recorder = {
    snapshots: [],
    events: [],
    usages: [],
    tails: [],
    errors: [],
    onSnapshot: (snapshot) => sink.snapshots.push(snapshot),
    onEvent: (activityEvent) => sink.events.push(activityEvent),
    onUsage: (usage) => sink.usages.push(usage),
    onLiveTail: (activityEvent) => sink.tails.push(activityEvent),
    onError: () => sink.errors.push("failed"),
  };
  return sink;
}

function event(index: number) {
  return {
    id: `e${index}`,
    index,
    revision: 0,
    phase: "complete" as const,
    ts: 1000 + index,
    type: "assistant" as const,
    blocks: [{ kind: "text" as const, text: `line ${index}` }],
  };
}

describe("SidecarDataSource", () => {
  it("names the session and mode in the path, since an index means nothing without them", async () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = {
      status: 200,
      body: JSON.stringify({ events: [event(0)], total: 1, usage: null }),
    };
    const source = new SidecarDataSource(transport);

    await source.fetchEventsPage(SESSION, 40, 20);

    expect(transport.requests.at(-1)?.path).toBe(
      "/api/sessions/claude/sid-1/events?offset=40&limit=20&mode=nice",
    );
  });

  it("opens one stream for a thread, not four", () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);

    source.subscribeSessionEvents(SESSION, 0, handlers());

    expect(transport.subscriptions.map((open) => open.path)).toEqual([
      "/api/sessions/claude/sid-1/timeline?mode=nice",
    ]);
  });

  it("routes a snapshot envelope to onSnapshot and a later one to onEvent", () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const sink = handlers();
    source.subscribeSessionEvents(SESSION, 0, sink);

    transport.deliver("timeline", {
      type: "timeline",
      envelope: {
        kind: "snapshot",
        sequence: 10,
        mode: "nice",
        events: [event(0)],
        windowStart: 4,
        total: 11,
        runState: "running",
        queue: { steer: 1, followUp: 2 },
        usage: { current: 100, limit: 200, updatedAt: 5 },
      },
    });
    transport.deliver("timeline", {
      type: "timeline",
      envelope: {
        kind: "upsert",
        sequence: 11,
        mode: "nice",
        events: [event(1)],
        windowStart: 4,
        total: 12,
        runState: "running",
        queue: { steer: 1, followUp: 2 },
      },
    });

    expect(sink.snapshots).toEqual([
      {
        events: [event(0)],
        total: 11,
        usage: { current: 100, limit: 200, updatedAt: 5 },
        windowStart: 4,
        state: { sequence: 10, runState: "running", queue: { steer: 1, followUp: 2 } },
      },
    ]);
    expect(sink.events).toEqual([event(1)]);
    // The second envelope carried no usage, so the meter is not blanked between readings.
    expect(sink.usages).toEqual([{ current: 100, limit: 200, updatedAt: 5 }]);
  });

  it("passes the live tail and its end through", () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const sink = handlers();
    source.subscribeSessionEvents(SESSION, 0, sink);

    transport.deliver("timeline", { type: "tail", event: event(2) });
    transport.deliver("timeline", { type: "tail", event: null });

    expect(sink.tails).toEqual([event(2), null]);
  });

  it("delivers extension UI from the thread's own stream", () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const seen: unknown[] = [];
    source.subscribeExtensionUI((uiEvent) => seen.push(uiEvent));
    source.subscribeSessionEvents(SESSION, 0, handlers());

    const request = { requestId: "q1", kind: "confirm" as const, expectsResponse: true };
    transport.deliver("timeline", { type: "ui", event: { type: "request", request } });

    expect(seen).toEqual([{ type: "request", request }]);
  });

  it("keeps the sidecar's error code rather than flattening it into a failure", async () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = {
      status: 409,
      body: JSON.stringify({ error: { code: "unsupported-mode", message: "no nice view" } }),
    };
    const source = new SidecarDataSource(transport);

    await expect(source.fetchEventsPage(SESSION, 0, 10)).rejects.toThrow(
      expect.objectContaining({ code: "unsupported-mode", status: 409 }) as Error,
    );
  });

  it("returns a raw transcript line as text, without a JSON round trip", async () => {
    const transport = new FakeHttpTransport();
    // Deliberately not valid JSON on its own terms as a body: the route answers text.
    transport.defaultResponse = { status: 200, body: '{"type":"assistant"}' };
    const source = new SidecarDataSource(transport);

    const line = await source.fetchRawEvent(SESSION, 4);

    expect(line).toBe('{"type":"assistant"}');
    expect(transport.requests.at(-1)?.path).toBe(
      "/api/sessions/claude/sid-1/events/4/raw?mode=nice",
    );
  });

  it("sends a message to the session's own route with its delivery", async () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = {
      status: 202,
      body: JSON.stringify({ requestId: "r1", delivery: "steer" }),
    };
    const source = new SidecarDataSource(transport);

    const receipt = await source.sendMessage(SESSION, "stop that", "steer");

    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/agent-sessions/claude/sid-1/messages",
      body: { text: "stop that", delivery: "steer" },
    });
    expect(receipt.delivery).toBe("steer");
  });

  it("subscribes to Bot snapshots and creates a Bot with a generated request id", async () => {
    const transport = new FakeHttpTransport();
    const bot = {
      botId: "bot-1",
      name: "Captain",
      environment: { kind: "directory", path: "/projects/alpha" },
      sessionRefs: [],
      metadata: { labels: [], custom: {} },
      grants: [],
      createdAt: 1,
      createdBy: { kind: "user" },
      environmentAvailability: "available",
      sessions: [],
      missingSessionRefs: [],
    };
    transport.responses.set("POST /api/bots", { status: 201, body: JSON.stringify(bot) });
    const source = new SidecarDataSource(transport);
    const snapshots: unknown[] = [];
    source.subscribeBots((snapshot) => snapshots.push(snapshot));
    transport.deliver("/api/bots/stream", { version: 2, revision: 0, bots: [] });

    const created = await source.createBot({
      name: "Captain",
      directoryPath: "/projects/alpha",
    });

    expect(snapshots).toEqual([{ version: 2, revision: 0, bots: [] }]);
    expect(created).toEqual(bot);
    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/bots",
      body: expect.objectContaining({
        requestId: expect.any(String),
        name: "Captain",
        directoryPath: "/projects/alpha",
      }),
    });
  });

  it("attaches existing sessions through the Bot-scoped route", async () => {
    const transport = new FakeHttpTransport();
    transport.responses.set("POST /api/bots/bot-1/sessions", {
      status: 200,
      body: JSON.stringify({ botId: "bot-1" }),
    });
    const source = new SidecarDataSource(transport);

    await source.addBotSessions("bot-1", {
      sessionRefs: [{ source: "pi", sessionId: "pi-1" }],
    });

    expect(transport.requests.at(-1)).toEqual({
      method: "POST",
      path: "/api/bots/bot-1/sessions",
      body: {
        requestId: expect.any(String),
        sessionRefs: [{ source: "pi", sessionId: "pi-1" }],
      },
    });
  });

  it("surfaces a typed Bot stream error instead of treating it as an empty snapshot", () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const errors: string[] = [];
    const snapshots: unknown[] = [];
    source.subscribeBots((snapshot) => snapshots.push(snapshot), (error) => errors.push(error));

    transport.deliver("/api/bots/stream", {
      error: { code: "bot-stream-failed", message: "bots.json is malformed", retryable: true },
    });

    expect(snapshots).toEqual([]);
    expect(errors).toEqual(["bots.json is malformed"]);
  });

  it("owns terminal creation, streaming, input, and resize over the Agent Feed routes", async () => {
    const transport = new FakeHttpTransport();
    const descriptor = {
      terminalId: "terminal-1",
      ptySessionName: "agent-resume-codex-session-1",
      pid: 42,
      columns: 80,
      rows: 24,
    };
    transport.responses.set("POST /api/terminals", {
      status: 201,
      body: JSON.stringify(descriptor),
    });
    transport.responses.set("POST /api/terminals/terminal-1/input", { status: 204, body: "" });
    transport.responses.set("POST /api/terminals/terminal-1/viewport", { status: 204, body: "" });
    const source = new SidecarDataSource(transport);
    const messages: unknown[] = [];

    expect(await source.openTerminal({
      kind: "agent-session",
      projectPath: "/projects/agent-desk",
      source: "codex",
      sessionId: "session-1",
    }, 80, 24)).toEqual(descriptor);
    source.subscribeTerminal("terminal-1", { onMessage: (message) => messages.push(message) });
    transport.open("/api/terminals/stream");
    await Promise.resolve();
    transport.deliver("/api/terminals/stream", {
      terminalId: "terminal-1",
      message: { type: "output", revision: "2", data: "aGk=" },
    });
    await source.sendTerminalInput("terminal-1", "pwd\r");
    await source.updateTerminalViewport("terminal-1", {
      sequence: "1",
      active: true,
      claim: true,
      columns: 100,
      rows: 30,
    });

    expect(messages).toEqual([{ type: "output", revision: "2", data: "aGk=" }]);
    expect(transport.requests.slice(-4)).toEqual([
      {
        method: "POST",
        path: "/api/terminals",
        body: {
          context: {
            kind: "agent-session",
            projectPath: "/projects/agent-desk",
            source: "codex",
            sessionId: "session-1",
          },
          columns: 80,
          rows: 24,
        },
      },
      // The viewer asks for its own screen replay, because the stream it joined is shared and
      // may have been running for another terminal long before this one existed.
      {
        method: "POST",
        path: "/api/terminals/terminal-1/checkpoint",
        body: undefined,
      },
      {
        method: "POST",
        path: "/api/terminals/terminal-1/input",
        body: { data: "pwd\r", encoding: "utf8" },
      },
      {
        method: "POST",
        path: "/api/terminals/terminal-1/viewport",
        body: {
          sequence: "1",
          active: true,
          claim: true,
          columns: 100,
          rows: 30,
        },
      },
    ]);
  });

  it("waits for the shared stream to carry before asking for a screen replay", async () => {
    // Nothing replays a message published while no observer was attached, and the stream connects a
    // round trip after it is asked to. Asking first left the terminal blank and silent, because
    // tmux sends nothing to a client that is already attached and unchanged.
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);

    source.subscribeTerminal("terminal-1", { onMessage: () => {} });
    await Promise.resolve();
    expect(transport.requests).toEqual([]);

    transport.open("/api/terminals/stream");
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.requests).toEqual([
      { method: "POST", path: "/api/terminals/terminal-1/checkpoint", body: undefined },
    ]);
  });

  it("serves every terminal from one connection, and holds none when all have closed", () => {
    // HTTP/1.1 gives a browser about six connections per origin and an EventSource holds one for
    // life, so a stream each would strand the seventh terminal and the panel's own requests too.
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const first: unknown[] = [];
    const second: unknown[] = [];

    const stopFirst = source.subscribeTerminal("terminal-1", { onMessage: (m) => first.push(m) });
    const stopSecond = source.subscribeTerminal("terminal-2", { onMessage: (m) => second.push(m) });
    expect(transport.subscriptions.map((subscription) => subscription.path))
      .toEqual(["/api/terminals/stream"]);

    transport.deliver("/api/terminals/stream", {
      terminalId: "terminal-2",
      message: { type: "output", revision: "7", data: "Zm9v" },
    });
    expect(first).toEqual([]);
    expect(second).toEqual([{ type: "output", revision: "7", data: "Zm9v" }]);

    stopFirst();
    expect(transport.subscriptions).toHaveLength(1);
    stopSecond();
    expect(transport.subscriptions).toHaveLength(0);
  });

  it("delivers a composer turn as one safe bracketed paste through the owned terminal", async () => {
    const transport = new FakeHttpTransport();
    transport.responses.set("POST /api/terminals/terminal-1/input", { status: 204, body: "" });
    const source = new SidecarDataSource(transport);

    await source.sendTerminalPrompt("terminal-1", "first line\nsecond \u001b[31mline");

    expect(transport.requests).toEqual([{
      method: "POST",
      path: "/api/terminals/terminal-1/input",
      body: {
        data: "\u001b[200~first line\nsecond \u241b[31mline\u001b[201~\r",
        encoding: "utf8",
      },
    }]);
  });

  it("refuses an oversized terminal prompt before writing partial input", async () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);

    await expect(source.sendTerminalPrompt("terminal-1", "x".repeat(64 * 1024)))
      .rejects.toThrow("64 KiB");
    expect(transport.requests).toEqual([]);
  });

  it("throws a typed error when the sidecar answers something that is not JSON", async () => {
    const transport = new FakeHttpTransport();
    transport.defaultResponse = { status: 200, body: "<html>gateway</html>" };
    const source = new SidecarDataSource(transport);

    await expect(source.createSession("/projects/alpha")).rejects.toBeInstanceOf(SidecarError);
  });
});

describe("fetchConfig", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves every asker from one request", async () => {
    const transport = new FakeHttpTransport();
    transport.responses.set("GET /api/config", { status: 200, body: '{"parkAvailable":true}' });
    const feed = new SidecarDataSource(transport);
    const [a, b, c] = await Promise.all([feed.fetchConfig(), feed.fetchConfig(), feed.fetchConfig()]);
    expect(transport.requests.filter((r) => r.path === "/api/config")).toHaveLength(1);
    expect(a).toEqual({ parkAvailable: true });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("retries a refused read instead of taking the loss as the answer", async () => {
    vi.useFakeTimers();
    const transport = new FakeHttpTransport();
    transport.responses.set("GET /api/config", {
      status: 503,
      body: '{"error":{"code":"relay-full","message":"too many agent-feed requests in flight"}}',
    });
    const feed = new SidecarDataSource(transport);
    const read = feed.fetchConfig();
    // The mount storm passes; the sidecar answers on the second attempt.
    await vi.advanceTimersByTimeAsync(10);
    transport.responses.set("GET /api/config", { status: 200, body: '{"parkAvailable":true}' });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(read).resolves.toEqual({ parkAvailable: true });
    expect(transport.requests.filter((r) => r.path === "/api/config")).toHaveLength(2);
  });

  it("rejects after every attempt fails, and the next call starts fresh", async () => {
    vi.useFakeTimers();
    const transport = new FakeHttpTransport();
    transport.responses.set("GET /api/config", { status: 503, body: '{"error":{"code":"relay-full"}}' });
    const feed = new SidecarDataSource(transport);
    const read = feed.fetchConfig();
    const outcome = read.then(
      () => "resolved",
      () => "rejected",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBe("rejected");
    const attempts = transport.requests.filter((r) => r.path === "/api/config").length;
    expect(attempts).toBe(3);
    // A fresh call is a fresh read, not the dead promise again.
    transport.responses.set("GET /api/config", { status: 200, body: '{"parkAvailable":false}' });
    await expect(feed.fetchConfig()).resolves.toEqual({ parkAvailable: false });
  });
});
