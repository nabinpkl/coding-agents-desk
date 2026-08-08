import { describe, expect, it, vi } from "vitest";
import { BridgeDataSource, WindowComposerError, WindowQuestionError } from "./BridgeDataSource";
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
      { onEvent: vi.fn(), onSnapshot: vi.fn() },
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
      { onEvent: vi.fn(), onSnapshot: vi.fn() },
    );
    source.subscribeSessionEvents(
      { source: "codex", sessionId: "shared", mode: "raw" },
      0,
      { onEvent: vi.fn(), onSnapshot: vi.fn() },
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
      onSnapshot: vi.fn(),
    });
    close();
    source.subscribeSessionEvents(session, 0, { onEvent: vi.fn(), onSnapshot: vi.fn() });

    expect(
      host.posted.filter(
        (message) => (message as { t?: string }).t === "agent-thread-sub",
      ),
    ).toHaveLength(2);
  });

  it("dispatches agent-live-tail to onLiveTail with the mapped event", () => {
    const { host, source } = makeSource();
    const onLiveTail = vi.fn();
    const session = { source: "claude" as const, sessionId: "thread", mode: "nice" as const };
    source.subscribeSessionEvents(session, 0, {
      onEvent: vi.fn(),
      onSnapshot: vi.fn(),
      onLiveTail,
    });

    host.deliver({
      t: "agent-live-tail",
      src: "claude",
      sid: "thread",
      ev: { id: "claude-live:msg_1", i: 0, rev: 1, ph: "streaming", ts: 1, tp: "assistant", b: [{ k: "text", t: "hello" }], mid: "msg_1" },
    });
    expect(onLiveTail).toHaveBeenCalledTimes(1);
    const event = onLiveTail.mock.calls[0]![0];
    expect(event.messageId).toBe("msg_1");
    expect(event.phase).toBe("streaming");

    host.deliver({ t: "agent-live-tail", src: "claude", sid: "thread", ev: null });
    expect(onLiveTail).toHaveBeenLastCalledWith(null);
  });

  it("rebases sequence and paging onto a lower-sequence reconnect snapshot", async () => {
    const { host, source } = makeSource();
    const onEvent = vi.fn();
    const onSnapshot = vi.fn();
    const session = { source: "pi" as const, sessionId: "thread", mode: "nice" as const };
    source.subscribeSessionEvents(
      session,
      0,
      { onEvent, onSnapshot },
    );
    host.deliver({
      t: "agent-thread-chunk",
      src: "pi",
      sid: "thread",
      md: "nice",
      ev: [
        { id: "stale-100", i: 100, rev: 0, ph: "complete", ts: 1, tp: "system", b: [] },
        { id: "stale-101", i: 101, rev: 0, ph: "complete", ts: 1, tp: "system", b: [] },
      ],
      ws: 100,
      tot: 102,
      lv: false,
      k: "snapshot",
      seq: 500,
      rs: "idle",
      qs: 0,
      qf: 0,
    });

    const racingOlder = source.fetchEventsPage(session, 99, 1);
    source.resumeAfterSessionReconnect();
    host.deliver({
      t: "agent-thread-chunk",
      src: "pi",
      sid: "thread",
      md: "nice",
      ev: [{ id: "older-99", i: 99, rev: 0, ph: "complete", ts: 1, tp: "user", b: [] }],
      ws: 99,
      tot: 102,
      lv: false,
      k: "page",
      seq: 500,
      rs: "idle",
      qs: 0,
      qf: 0,
    });
    await expect(racingOlder).resolves.toMatchObject({
      events: [{ id: "older-99", index: 99 }],
    });
    expect(onSnapshot).not.toHaveBeenCalled();

    host.deliver({
      t: "agent-thread-chunk",
      src: "pi",
      sid: "thread",
      md: "nice",
      ev: [
        { id: "fresh-100", i: 100, rev: 0, ph: "complete", ts: 2, tp: "assistant", b: [] },
      ],
      ws: 100,
      tot: 101,
      lv: false,
      k: "snapshot",
      seq: 12,
      rs: "idle",
      qs: 0,
      qf: 0,
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(onSnapshot.mock.calls[0]?.[0]).toMatchObject({
      events: [{ id: "fresh-100", index: 100 }],
      total: 101,
      windowStart: 100,
      state: { sequence: 12 },
    });
    await expect(source.fetchEventsPage(session, 100, 2)).resolves.toMatchObject({
      events: [{ id: "fresh-100", index: 100 }],
      total: 101,
    });

    const older = source.fetchEventsPage(session, 99, 1);
    expect(host.posted.at(-1)).toEqual({
      t: "agent-thread-older", src: "pi", sid: "thread", bi: 100, lim: 1, md: "nice",
    });
    host.deliver({
      t: "agent-thread-chunk",
      src: "pi",
      sid: "thread",
      md: "nice",
      ev: [{ id: "user-99", i: 99, rev: 0, ph: "complete", ts: 1, tp: "user", b: [] }],
      ws: 99,
      tot: 101,
      lv: false,
      k: "page",
      seq: 12,
      rs: "idle",
      qs: 0,
      qf: 0,
    });
    await expect(older).resolves.toMatchObject({
      events: [expect.objectContaining({ index: 99 })],
      total: 101,
    });
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
    source.subscribeSessionEvents(session, 0, { onEvent: vi.fn(), onSnapshot: vi.fn(), onUsage });

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
    source.subscribeSessionEvents(session, 0, { onEvent: vi.fn(), onSnapshot: vi.fn(), onUsage });

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
    source.subscribeSessionEvents(session, 0, { onEvent: vi.fn(), onSnapshot: vi.fn(), onUsage });

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
    host.deliver({
      t: "agent-command-receipt",
      rid: "create-1",
      src: "pi",
      sid: "pi-session",
      del: "created",
      s: {
        sid: "pi-session",
        src: "pi",
        ttl: "New Pi session",
        lea: 123,
        ac: "ready",
        cap: { md: ["nice"], snd: true, str: true, abt: true, raw: false, pty: false, xui: true },
      },
    });
    await expect(pending).resolves.toMatchObject({
      sessionId: "pi-session",
      delivery: "created",
      session: {
        sessionId: "pi-session",
        capabilities: { canSend: true, canOpenTerminal: false, supportsExtensionUI: true },
      },
    });
  });

  it("replaces a streaming event by revision and publishes run plus queue state", () => {
    const { host, source } = makeSource();
    const onEvent = vi.fn();
    const onState = vi.fn();
    source.subscribeSessionEvents(
      { source: "pi", sessionId: "thread", mode: "nice" },
      0,
      { onEvent, onSnapshot: vi.fn(), onState },
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

  it("accepts an older-page reply whose read sequence trails the live stream", async () => {
    const { host, source } = makeSource();
    source.subscribeSessionEvents(
      { source: "pi", sessionId: "thread", mode: "nice" },
      0,
      { onEvent: vi.fn(), onSnapshot: vi.fn() },
    );
    host.deliver({
      t: "agent-thread-chunk", src: "pi", sid: "thread", md: "nice",
      ev: [{ id: "event-100", i: 100, rev: 0, ph: "complete", ts: 100, tp: "system", b: [{ k: "metadata", tx: "100" }] }],
      ws: 100, tot: 201, lv: false, k: "snapshot", seq: 10, rs: "running", qs: 0, qf: 0,
    });

    const older = source.fetchEventsPage(
      { source: "pi", sessionId: "thread", mode: "nice" },
      99,
      1,
    );
    expect(host.posted.at(-1)).toMatchObject({
      t: "agent-thread-older", src: "pi", sid: "thread", bi: 100, lim: 1,
    });

    host.deliver({
      t: "agent-thread-chunk", src: "pi", sid: "thread", md: "nice",
      ev: [{ id: "event-200", i: 200, rev: 1, ph: "streaming", ts: 200, tp: "assistant", b: [{ k: "text", tx: "live" }] }],
      ws: 200, tot: 201, lv: true, k: "upsert", seq: 12, rs: "running", qs: 0, qf: 0,
    });
    host.deliver({
      t: "agent-thread-chunk", src: "pi", sid: "thread", md: "nice",
      ev: [{ id: "event-99", i: 99, rev: 0, ph: "complete", ts: 99, tp: "system", b: [{ k: "metadata", tx: "old" }] }],
      ws: 99, tot: 201, lv: false, k: "page", seq: 11, rs: "running", qs: 0, qf: 0,
    });

    await expect(older).resolves.toMatchObject({
      events: [expect.objectContaining({ id: "event-99", index: 99 })],
      total: 201,
    });
  });

  it("correlates extension responses and broadcasts the shared dismissal", async () => {
    const { host, source } = makeSource();
    const listener = vi.fn();
    source.subscribeExtensionUI(listener);
    host.deliver({
      t: "agent-extension-ui-request", src: "pi", sid: "thread", rid: "ui-1",
      k: "confirm", ttl: "Proceed?", m: "Run the extension?", er: true,
    });
    const request = listener.mock.calls[0]?.[0]?.request;
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ type: "request" });
    expect(request).toMatchObject({ requestId: "ui-1", kind: "confirm", expectsResponse: true });
    const response = source.respondToExtensionUI(request, true);
    expect(host.posted.at(-1)).toEqual({
      t: "agent-extension-ui-response", src: "pi", sid: "thread", rid: "ui-1", v: true,
    });
    host.deliver({ t: "agent-command-receipt", rid: "ui-1", src: "pi", sid: "thread", del: "ui" });
    await expect(response).resolves.toMatchObject({ requestId: "ui-1", delivery: "ui" });
    host.deliver({ t: "agent-extension-ui-dismissed", src: "pi", sid: "thread", rid: "ui-1" });
    expect(listener.mock.calls[1]?.[0]).toEqual({
      type: "dismiss", source: "pi", sessionId: "thread", requestId: "ui-1",
    });
  });
});

describe("BridgeDataSource Claude window composer", () => {
  it("watches by session id alone and reports the mapped reason when nothing owns it", () => {
    const { host, source } = makeSource();
    const listener = vi.fn();
    const unwatch = source.subscribeWindowComposer("session-a", listener);

    // No source on the wire: the mapping is resume-based, resolved from the process tree, so the
    // panel never names a harness.
    expect(host.posted.at(-1)).toEqual({
      t: "agent-window-input-watch",
      sub: "window-input-1",
      sid: "session-a",
    });

    host.deliver({
      t: "agent-window-input-status",
      sub: "window-input-1",
      sid: "session-a",
      en: false,
      r: "terminal-only",
    });
    expect(listener).toHaveBeenCalledWith({
      sessionId: "session-a",
      enabled: false,
      reason: "terminal-only",
      onActiveDesktop: false,
      composerText: null,
    });

    unwatch();
    expect(host.posted.at(-1)).toEqual({
      t: "agent-window-input-unwatch",
      sub: "window-input-1",
    });
  });

  it("ignores a status addressed to a session this subscription is no longer watching", () => {
    const { host, source } = makeSource();
    const listener = vi.fn();
    source.subscribeWindowComposer("session-a", listener);

    // The host re-resolves on a timer, so a status for the previous session can land after a switch.
    // Adopting it would prefill the field from the wrong window.
    host.deliver({
      t: "agent-window-input-status",
      sub: "window-input-1",
      sid: "session-b",
      en: true,
      cur: true,
      tx: "text from another window",
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("resolves a fill with the host's read-back and rejects with the reason code", async () => {
    const { host, source } = makeSource();

    const filled = source.syncWindowComposer("session-a", "review the diff");
    expect(host.posted.at(-1)).toEqual({
      t: "agent-window-input-sync",
      rid: "window-sync-1",
      sid: "session-a",
      tx: "review the diff",
    });
    host.deliver({
      t: "agent-window-input-result",
      rid: "window-sync-1",
      sid: "session-a",
      ok: true,
      tx: "review the diff",
    });
    // The read-back, not void: it is what proves the text landed in the real composer.
    await expect(filled).resolves.toBe("review the diff");

    const failed = source.syncWindowComposer("session-a", "nope");
    host.deliver({
      t: "agent-window-input-result",
      rid: "window-sync-2",
      sid: "session-a",
      ok: false,
      r: "focus-stolen",
    });
    await expect(failed).rejects.toBeInstanceOf(WindowComposerError);
    await expect(failed).rejects.toMatchObject({ reason: "focus-stolen" });
  });

  it("submits by filling and sending, and rejects with the reason code", async () => {
    const { host, source } = makeSource();

    const submitted = source.submitWindowComposer("session-a", "run the tests");
    expect(host.posted.at(-1)).toEqual({
      t: "agent-window-input-submit",
      rid: "window-submit-1",
      sid: "session-a",
      tx: "run the tests",
    });
    host.deliver({
      t: "agent-window-input-result",
      rid: "window-submit-1",
      sid: "session-a",
      ok: true,
      // A committed prompt clears the composer, so the empty read-back is the success signal.
      tx: "",
    });
    await expect(submitted).resolves.toBe("");

    const failed = source.submitWindowComposer("session-a", "nope");
    host.deliver({
      t: "agent-window-input-result",
      rid: "window-submit-2",
      sid: "session-a",
      ok: false,
      r: "composer-missing",
    });
    await expect(failed).rejects.toMatchObject({ reason: "composer-missing" });
  });

  it("treats a cleared composer as a real answer rather than a missing one", async () => {
    const { host, source } = makeSource();
    const cleared = source.syncWindowComposer("session-a", "");
    host.deliver({
      t: "agent-window-input-result",
      rid: "window-sync-1",
      sid: "session-a",
      ok: true,
      tx: "",
    });
    await expect(cleared).resolves.toBe("");

    const malformed = source.readWindowComposer("session-a");
    host.deliver({
      t: "agent-window-input-result",
      rid: "window-read-2",
      sid: "session-a",
      ok: true,
    });
    await expect(malformed).rejects.toThrow("carried no text");
  });

  it("re-posts composer watches after a reconnect, because the host dropped the old lane's sink", () => {
    const { host, source } = makeSource();
    source.subscribeWindowComposer("session-a", vi.fn());
    const before = host.posted.length;

    source.resumeAfterSessionReconnect();

    expect(host.posted.slice(before)).toEqual([
      { t: "agent-window-input-watch", sub: "window-input-1", sid: "session-a" },
    ]);
  });

  it("unwatches composers on destroy and fails every request in flight", async () => {
    const { host, source } = makeSource();
    source.subscribeWindowComposer("session-a", vi.fn());
    const pending = source.syncWindowComposer("session-a", "in flight");

    source.destroy();

    expect(host.posted).toContainEqual({
      t: "agent-window-input-unwatch",
      sub: "window-input-1",
    });
    await expect(pending).rejects.toThrow("BridgeDataSource destroyed");
  });
});

describe("BridgeDataSource AskUserQuestion mirror", () => {
  it("watches the panel state and maps the augmentation, never content", () => {
    const { host, source } = makeSource();
    const listener = vi.fn();
    const unwatch = source.subscribeWindowQuestion("session-a", listener);

    expect(host.posted.at(-1)).toEqual({
      t: "agent-window-question-watch",
      sub: "question-1",
      sid: "session-a",
    });

    host.deliver({
      t: "agent-window-question-status",
      sub: "question-1",
      sid: "session-a",
      en: true,
      cur: false,
      pr: true,
      sel: [0, 2],
      oth: "custom",
      sb: false,
    });
    expect(listener).toHaveBeenCalledWith({
      sessionId: "session-a",
      enabled: true,
      reason: null,
      onActiveDesktop: false,
      present: true,
      selected: [0, 2],
      otherText: "custom",
      submitEnabled: false,
    });

    unwatch();
    expect(host.posted.at(-1)).toEqual({
      t: "agent-window-question-unwatch",
      sub: "question-1",
    });
  });

  it("keeps present null for a window on another Desktop and maps an absent panel to false", () => {
    const { host, source } = makeSource();
    const listener = vi.fn();
    source.subscribeWindowQuestion("session-a", listener);

    host.deliver({
      t: "agent-window-question-status",
      sub: "question-1",
      sid: "session-a",
      en: true,
      cur: false,
    });
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ present: null, onActiveDesktop: false }),
    );

    host.deliver({
      t: "agent-window-question-status",
      sub: "question-1",
      sid: "session-a",
      en: true,
      cur: true,
      pr: false,
    });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ present: false }));
  });

  it("ignores a status addressed to a session this subscription is no longer watching", () => {
    const { host, source } = makeSource();
    const listener = vi.fn();
    source.subscribeWindowQuestion("session-a", listener);

    host.deliver({
      t: "agent-window-question-status",
      sub: "question-1",
      sid: "session-b",
      en: true,
      pr: true,
      sel: [0],
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("posts each action with the wire payload and resolves with the post-action state", async () => {
    const { host, source } = makeSource();

    const selected = source.selectQuestionOption("session-a", 1, true);
    expect(host.posted.at(-1)).toEqual({
      t: "agent-window-question-action",
      rid: "question-action-1",
      sid: "session-a",
      k: "select",
      oi: 1,
      v: 1,
    });
    host.deliver({
      t: "agent-window-question-result",
      rid: "question-action-1",
      sid: "session-a",
      ok: true,
      pr: true,
      sel: [1],
      oth: null,
      sb: true,
    });
    await expect(selected).resolves.toMatchObject({ selected: [1], submitEnabled: true });

    const unchecked = source.selectQuestionOption("session-a", 1, false);
    expect(host.posted.at(-1)).toEqual({
      t: "agent-window-question-action",
      rid: "question-action-2",
      sid: "session-a",
      k: "select",
      oi: 1,
      v: 0,
    });
    host.deliver({
      t: "agent-window-question-result",
      rid: "question-action-2",
      sid: "session-a",
      ok: true,
      pr: true,
      sel: [],
      oth: null,
      sb: false,
    });
    await expect(unchecked).resolves.toMatchObject({ selected: [] });

    const typed = source.setQuestionOther("session-a", "custom answer");
    expect(host.posted.at(-1)).toEqual({
      t: "agent-window-question-action",
      rid: "question-action-3",
      sid: "session-a",
      k: "other",
      tx: "custom answer",
    });
    host.deliver({
      t: "agent-window-question-result",
      rid: "question-action-3",
      sid: "session-a",
      ok: true,
      pr: true,
      sel: [],
      oth: "custom answer",
      sb: true,
    });
    await expect(typed).resolves.toMatchObject({ otherText: "custom answer" });

    const submitted = source.submitQuestion("session-a");
    expect(host.posted.at(-1)).toEqual({
      t: "agent-window-question-action",
      rid: "question-action-4",
      sid: "session-a",
      k: "submit",
    });
    host.deliver({
      t: "agent-window-question-result",
      rid: "question-action-4",
      sid: "session-a",
      ok: true,
      pr: false,
      sel: [],
      oth: null,
      sb: null,
    });
    await expect(submitted).resolves.toMatchObject({ present: false });
  });

  it("rejects an action with the host's reason code", async () => {
    const { host, source } = makeSource();
    const skipped = source.skipQuestion("session-a");
    host.deliver({
      t: "agent-window-question-result",
      rid: "question-action-1",
      sid: "session-a",
      ok: false,
      r: "question-missing",
    });
    await expect(skipped).rejects.toBeInstanceOf(WindowQuestionError);
    await expect(skipped).rejects.toMatchObject({ reason: "question-missing" });
  });

  it("re-posts question watches after a reconnect, like the composer watches", () => {
    const { host, source } = makeSource();
    source.subscribeWindowQuestion("session-a", vi.fn());
    const before = host.posted.length;

    source.resumeAfterSessionReconnect();

    expect(host.posted.slice(before)).toEqual([
      { t: "agent-window-question-watch", sub: "question-1", sid: "session-a" },
    ]);
  });
});
