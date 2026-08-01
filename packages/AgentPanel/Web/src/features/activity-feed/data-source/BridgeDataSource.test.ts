import { describe, expect, it, vi } from "vitest";
import { BridgeDataSource } from "./BridgeDataSource";
import { FakeHostBridge } from "./HostBridge";

function makeSource() {
  const host = new FakeHostBridge();
  let sequence = 0;
  const source = new BridgeDataSource(host, {
    requestIDFactory: (prefix) => `${prefix}-${++sequence}`,
  });
  return { host, source };
}

describe("BridgeDataSource visibility lifecycle", () => {
  it("resubscribes only the currently active layers after reconnect", () => {
    const { host, source } = makeSource();
    const closeProjects = source.subscribeProjects(vi.fn());
    const projectsWatch = host.posted.at(-1);

    source.resumeAfterSessionReconnect();
    expect(host.posted.at(-1)).toEqual(projectsWatch);
    closeProjects();

    const closeSessions = source.subscribeProjectSessions("/project", vi.fn());
    const beforeReconnect = host.posted.length;

    source.resumeAfterSessionReconnect();

    expect(host.posted.slice(beforeReconnect)).toEqual([
      {
        t: "agent-project-sessions-watch",
        sub: "project-sessions-2",
        pp: "/project",
      },
    ]);
    closeSessions();

    const closeThread = source.subscribeSessionEvents(
      { source: "codex", sessionId: "shared", mode: "raw" },
      0,
      { onEvent: vi.fn() },
    );
    const beforeThreadReconnect = host.posted.length;
    source.resumeAfterSessionReconnect();
    expect(host.posted.slice(beforeThreadReconnect)).toEqual([
      { t: "agent-thread-sub", src: "codex", sid: "shared", md: "raw" },
    ]);
    closeThread();
  });

  it("destroy closes project, project-session, and every source-scoped thread", () => {
    const { host, source } = makeSource();
    source.subscribeProjects(vi.fn());
    source.subscribeProjectSessions("/project", vi.fn());
    source.subscribeSessionEvents(
      { source: "claude", sessionId: "shared", mode: "raw" },
      0,
      { onEvent: vi.fn() },
    );
    source.subscribeSessionEvents(
      { source: "codex", sessionId: "shared", mode: "raw" },
      0,
      { onEvent: vi.fn() },
    );

    source.destroy();

    expect(host.posted).toContainEqual({
      t: "agent-projects-unwatch",
      sub: "projects-1",
    });
    expect(host.posted).toContainEqual({
      t: "agent-project-sessions-unwatch",
      sub: "project-sessions-2",
    });
    expect(host.posted).toContainEqual({
      t: "agent-thread-unsub",
      src: "claude",
      sid: "shared",
    });
    expect(host.posted).toContainEqual({
      t: "agent-thread-unsub",
      src: "codex",
      sid: "shared",
    });
  });

  it("releases thread state after the final listener closes", () => {
    const { host, source } = makeSource();
    const session = { source: "codex" as const, sessionId: "thread", mode: "raw" as const };
    const close = source.subscribeSessionEvents(session, 0, {
      onEvent: vi.fn(),
    });
    close();
    source.subscribeSessionEvents(session, 0, { onEvent: vi.fn() });

    expect(
      host.posted.filter(
        (message) => (message as { t?: string }).t === "agent-thread-sub",
      ),
    ).toHaveLength(2);
  });

  it("delivers only newly observed events from a reconnect snapshot", () => {
    const { host, source } = makeSource();
    const onEvent = vi.fn();
    source.subscribeSessionEvents(
      { source: "codex", sessionId: "thread", mode: "raw" },
      0,
      { onEvent },
    );
    host.deliver({
      t: "agent-thread-chunk",
      src: "codex",
      sid: "thread",
      md: "raw",
      ev: [{ id: "user-0", i: 0, rev: 0, ph: "complete", ts: 1, tp: "user", b: [] }],
      ws: 0,
      tot: 1,
      lv: false,
      k: "snapshot",
      seq: 1,
      rs: "idle",
      qs: 0,
      qf: 0,
    });

    source.resumeAfterSessionReconnect();
    host.deliver({
      t: "agent-thread-chunk",
      src: "codex",
      sid: "thread",
      md: "raw",
      ev: [
        { id: "user-0", i: 0, rev: 0, ph: "complete", ts: 1, tp: "user", b: [] },
        { id: "assistant-1", i: 1, rev: 0, ph: "complete", ts: 2, tp: "assistant", b: [] },
      ],
      ws: 0,
      tot: 2,
      lv: false,
      k: "snapshot",
      seq: 2,
      rs: "idle",
      qs: 0,
      qf: 0,
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ index: 1 });
  });
});

describe("BridgeDataSource context occupancy", () => {
  const session = { source: "claude" as const, sessionId: "thread", mode: "raw" as const };

  function chunk(
    overrides: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      t: "agent-thread-chunk",
      src: "claude",
      sid: "thread",
      ev: [],
      ws: 0,
      tot: 1,
      lv: true,
      md: "raw",
      k: "upsert",
      seq: 1,
      rs: "idle",
      qs: 0,
      qf: 0,
      ...overrides,
    };
  }

  it("announces occupancy to a live subscriber as chunks arrive", () => {
    const { host, source } = makeSource();
    const onUsage = vi.fn();
    source.subscribeSessionEvents(session, 0, { onEvent: vi.fn(), onUsage });

    host.deliver(chunk({ u: { cur: 40_000, lim: 200_000, ua: 10 } }));
    host.deliver(chunk({ u: { cur: 52_000, lim: 200_000, ua: 11 } }));

    // The whole point of the stage: the readout moves without a refetch, which
    // is what lets 7,197 token_count rows leave the transcript entirely.
    expect(onUsage.mock.calls.map(([usage]) => usage?.current)).toEqual([
      40_000,
      52_000,
    ]);
  });

  it("keeps the last reading when a chunk publishes none", async () => {
    const { host, source } = makeSource();
    const onUsage = vi.fn();
    source.subscribeSessionEvents(session, 0, { onEvent: vi.fn(), onUsage });

    host.deliver(chunk({ lv: false, u: { cur: 40_000, lim: 200_000, ua: 10 } }));
    host.deliver(chunk({ u: undefined }));

    // Most transcript lines publish no occupancy, so clearing on their arrival
    // would blank the meter between readings rather than hold the last one.
    expect(onUsage).toHaveBeenCalledTimes(1);
    await expect(source.fetchEventsPage(session, 0, 1)).resolves.toMatchObject({
      usage: { current: 40_000, limit: 200_000 },
    });
  });

  it("reports no window rather than a malformed one", () => {
    const { host, source } = makeSource();
    const onUsage = vi.fn();
    source.subscribeSessionEvents(session, 0, { onEvent: vi.fn(), onUsage });

    host.deliver(chunk({ u: { cur: 40_000, lim: null, ua: 10 } }));

    // null limit is a real answer -- the sidecar has no window for the model --
    // and the meter must render a bare count instead of dividing by it.
    expect(onUsage.mock.calls[0]?.[0]).toEqual({
      current: 40_000,
      limit: null,
      updatedAt: 10,
    });
  });
});

describe("BridgeDataSource live agent control", () => {
  it("correlates create commands and exposes the created session identity", async () => {
    const { host, source } = makeSource();
    const pending = source.createSession("/project");
    expect(host.posted.at(-1)).toMatchObject({
      t: "agent-session-create",
      rid: "create-1",
      src: "pi",
      pp: "/project",
    });
    host.deliver({ t: "agent-command-receipt", rid: "create-1", src: "pi", sid: "pi-session", del: "created" });
    await expect(pending).resolves.toMatchObject({ sid: "pi-session", del: "created" });
  });

  it("replaces a streaming event by revision and publishes run plus queue state", () => {
    const { host, source } = makeSource();
    const onEvent = vi.fn();
    const onState = vi.fn();
    source.subscribeSessionEvents(
      { source: "pi", sessionId: "thread", mode: "nice" },
      0,
      { onEvent, onState },
    );
    host.deliver({
      t: "agent-thread-chunk", src: "pi", sid: "thread", md: "nice",
      ev: [{ id: "assistant-1", i: 0, rev: 0, ph: "streaming", ts: 1, tp: "assistant", b: [{ k: "text", tx: "Hel" }] }],
      ws: 0, tot: 1, lv: false, k: "snapshot", seq: 1, rs: "running", qs: 0, qf: 0,
    });
    host.deliver({
      t: "agent-thread-chunk", src: "pi", sid: "thread", md: "nice",
      ev: [{ id: "assistant-1", i: 0, rev: 1, ph: "complete", ts: 1, tp: "assistant", b: [{ k: "text", tx: "Hello" }] }],
      ws: 0, tot: 1, lv: true, k: "upsert", seq: 2, rs: "idle", qs: 0, qf: 1,
    });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ id: "assistant-1", revision: 1, phase: "complete" });
    expect(onState).toHaveBeenLastCalledWith({ sequence: 2, runState: "idle", queue: { steer: 0, followUp: 1 } });
  });

  it("fans extension prompts into the panel and posts the first response", () => {
    const { host, source } = makeSource();
    const listener = vi.fn();
    source.subscribeExtensionUI(listener);
    host.deliver({
      t: "agent-extension-ui-request", src: "pi", sid: "thread", rid: "ui-1",
      k: "confirm", ttl: "Proceed?", m: "Run the extension?", er: true,
    });
    const request = listener.mock.calls[0]?.[0];
    expect(request).toMatchObject({ requestId: "ui-1", kind: "confirm", expectsResponse: true });
    source.respondToExtensionUI(request, true);
    expect(host.posted.at(-1)).toEqual({
      t: "agent-extension-ui-response", src: "pi", sid: "thread", rid: "ui-1", v: true,
    });
  });
});
