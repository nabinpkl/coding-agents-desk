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
      { source: "codex", sessionId: "shared" },
      0,
      { onEvent: vi.fn() },
    );
    const beforeThreadReconnect = host.posted.length;
    source.resumeAfterSessionReconnect();
    expect(host.posted.slice(beforeThreadReconnect)).toEqual([
      { t: "agent-thread-sub", src: "codex", sid: "shared" },
    ]);
    closeThread();
  });

  it("destroy closes project, project-session, and every source-scoped thread", () => {
    const { host, source } = makeSource();
    source.subscribeProjects(vi.fn());
    source.subscribeProjectSessions("/project", vi.fn());
    source.subscribeSessionEvents(
      { source: "claude", sessionId: "shared" },
      0,
      { onEvent: vi.fn() },
    );
    source.subscribeSessionEvents(
      { source: "codex", sessionId: "shared" },
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
    const session = { source: "codex" as const, sessionId: "thread" };
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
      { source: "codex", sessionId: "thread" },
      0,
      { onEvent },
    );
    host.deliver({
      t: "agent-thread-chunk",
      src: "codex",
      sid: "thread",
      ev: [{ i: 0, ts: 1, tp: "user", b: [] }],
      ws: 0,
      tot: 1,
      lv: false,
    });

    source.resumeAfterSessionReconnect();
    host.deliver({
      t: "agent-thread-chunk",
      src: "codex",
      sid: "thread",
      ev: [
        { i: 0, ts: 1, tp: "user", b: [] },
        { i: 1, ts: 2, tp: "assistant", b: [] },
      ],
      ws: 0,
      tot: 2,
      lv: false,
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ index: 1 });
  });
});
