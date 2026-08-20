/**
 * The panel's half of the shared wire contract.
 *
 * `agent-feed/wire/contract-fixture.json` is one document read by two suites: the sidecar's
 * (`agent-feed/sidecar/src/http/contractFixture.test.ts`) asserts its routes emit exactly these
 * bodies, and this one asserts the data source turns them into what the view renders.
 *
 * One document, not two fixtures, on purpose. Per-side fixtures are what hid the last wire drift:
 * each suite was green against its own copy while the two shapes disagreed in production. Here a
 * body the sidecar changed and the panel cannot read fails on exactly one side.
 */

import { describe, expect, it } from "vitest";
import type { SummaryResult, SummaryStreamMessage } from "@agentdesk/agent-feed-wire";
import fixture from "../../../../../../../agent-feed/wire/contract-fixture.json";
import { SidecarDataSource } from "./SidecarDataSource";
import { FakeHttpTransport } from "../transport/FakeHttpTransport";
import type { SessionEventsHandlers, SessionEventsSnapshot } from "./AgentDataSource";
// The panel's own event type, not the wire's. They are deliberately different: this one is the
// normalization target `activityNormalization.ts` rebuilds every event into, and it is looser
// (optional `id`, an extra `"error"` phase) because a malformed event still has to render.
import type { ActivityEvent, TokenUsage } from "../useSessionEventsStream";
import type { AgentUiEvent } from "@agentdesk/agent-feed-wire";

const SESSION = { source: "pi", sessionId: "s1", mode: "nice" as const };

function recorder() {
  const snapshots: SessionEventsSnapshot[] = [];
  const events: ActivityEvent[] = [];
  const tails: (ActivityEvent | null)[] = [];
  const usages: (TokenUsage | null)[] = [];
  const errors: string[] = [];
  const handlers: SessionEventsHandlers = {
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onEvent: (activityEvent) => events.push(activityEvent),
    onLiveTail: (activityEvent) => tails.push(activityEvent),
    onUsage: (usage) => usages.push(usage),
    onError: () => errors.push("failed"),
  };
  return { snapshots, events, tails, usages, errors, handlers };
}

describe("the shared wire contract", () => {
  it("opens a thread from the sidecar's own snapshot message", () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const sink = recorder();
    source.subscribeSessionEvents(SESSION, 0, sink.handlers);

    transport.deliver("/timeline", JSON.stringify(fixture.timelineSnapshot));

    expect(sink.snapshots).toHaveLength(1);
    const snapshot = sink.snapshots[0]!;
    expect(snapshot.windowStart).toBe(fixture.timelineSnapshot.envelope.windowStart);
    expect(snapshot.total).toBe(fixture.timelineSnapshot.envelope.total);
    expect(snapshot.events.map((e) => e.id)).toEqual(
      fixture.timelineSnapshot.envelope.events.map((e) => e.id),
    );
    // Not merged into the snapshot: run state and queue depth are session state, and the view
    // reads them separately from the rows.
    expect(snapshot.state.runState).toBe("idle");
    expect(snapshot.state.queue).toEqual({ steer: 0, followUp: 0 });
  });

  it("revises the open window from an upsert, and carries its occupancy", () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const sink = recorder();
    source.subscribeSessionEvents(SESSION, 0, sink.handlers);

    transport.deliver("/timeline", JSON.stringify(fixture.timelineSnapshot));
    transport.deliver("/timeline", JSON.stringify(fixture.timelineUpsert));

    // An upsert appends within the window rather than replacing it, so it must NOT arrive as a
    // second snapshot: doing so would drop the runtime-local indices the viewer is holding.
    expect(sink.snapshots).toHaveLength(1);
    expect(sink.events.map((e) => e.id)).toEqual(["e2"]);
    expect(sink.usages.at(-1)).toEqual(fixture.timelineUpsert.envelope.usage);
  });

  it("mirrors the live tail, including its end", () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const sink = recorder();
    source.subscribeSessionEvents(SESSION, 0, sink.handlers);

    transport.deliver("/timeline", JSON.stringify(fixture.timelineTail));
    transport.deliver("/timeline", JSON.stringify({ type: "tail", event: null }));

    expect(sink.tails.map((tail) => tail?.id ?? null)).toEqual(["tail-1", null]);
  });

  it("routes an extension-UI prompt off the same stream to the UI listeners", () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const received: AgentUiEvent[] = [];
    source.subscribeExtensionUI((event) => received.push(event));
    source.subscribeSessionEvents(SESSION, 0, recorder().handlers);

    transport.deliver("/timeline", JSON.stringify(fixture.timelineUi));

    expect(received).toEqual([fixture.timelineUi.event]);
  });

  it("reports a stream error without ending the subscription", () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    const sink = recorder();
    source.subscribeSessionEvents(SESSION, 0, sink.handlers);

    transport.deliver("/timeline", JSON.stringify(fixture.timelineError));
    transport.deliver("/timeline", JSON.stringify(fixture.timelineSnapshot));

    expect(sink.errors).toEqual(["failed"]);
    // The stream is still live: a non-fatal error is the sidecar saying one thing failed, not
    // that the thread is over, and re-subscribing on it would restart the window for nothing.
    expect(sink.snapshots).toHaveLength(1);
  });

  it("reads the projects, sessions, page, and descriptor bodies the sidecar writes", async () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);

    const projects: unknown[] = [];
    const sessions = new Map<string, unknown[]>();
    // Both message shapes on the one stream, told apart by the keys the sidecar writes.
    source.subscribeInventory([fixture.sessions.projectPath], {
      onProjects: (next) => projects.push(...next),
      onSessions: (projectPath, next) => sessions.set(projectPath, [...next]),
    });
    transport.deliver("/api/inventory/stream", JSON.stringify(fixture.projects));
    transport.deliver("/api/inventory/stream", JSON.stringify(fixture.sessions));
    expect(projects).toEqual(fixture.projects.projects);
    expect(sessions.get(fixture.sessions.projectPath)).toEqual(fixture.sessions.sessions);

    transport.responses.set("GET /api/sessions/pi/s1/events?offset=0&limit=1&mode=nice", {
      status: 200,
      body: JSON.stringify(fixture.eventsPage),
    });
    const page = await source.fetchEventsPage(SESSION, 0, 1);
    expect(page.total).toBe(fixture.eventsPage.total);
    expect(page.events.map((e) => e.id)).toEqual(fixture.eventsPage.events.map((e) => e.id));

    transport.responses.set("POST /api/agent-sessions", {
      status: 201,
      body: JSON.stringify(fixture.sessionDescriptor),
    });
    const created = await source.createSession(fixture.sessionDescriptor.projectPath, "pi");
    expect(created).toEqual(fixture.sessionDescriptor);
  });

  it("preserves the sidecar's error code, because the panel acts on it", async () => {
    const transport = new FakeHttpTransport();
    const source = new SidecarDataSource(transport);
    transport.defaultResponse = { status: 404, body: JSON.stringify(fixture.errorPayload) };

    await expect(source.fetchEventsPage(SESSION, 0, 1)).rejects.toMatchObject({
      code: fixture.errorPayload.error.code,
      status: 404,
    });
  });
});

describe("the summary contract", () => {
  it("reads the sidecar's digest into the shape the band renders", () => {
    const transport = new FakeHttpTransport();
    const messages: SummaryStreamMessage[] = [];
    new SidecarDataSource(transport).summarizeTurn(
      { source: "pi", sessionId: "s1" },
      { onMessage: (message) => messages.push(message), onError: () => {} },
    );
    transport.deliver("/summary", { type: "result", result: fixture.summaryResult });

    const [message] = messages;
    expect(message?.type).toBe("result");
    const result = (message as { result: SummaryResult }).result;
    expect(result).toEqual(fixture.summaryResult);
    // The band reads exactly these; a rename on the sidecar side lands here rather than as an
    // empty panel.
    expect(result.headline.length).toBeGreaterThan(0);
    expect(result.narrative.length).toBeGreaterThan(0);
    expect(result.filesTouched[0]).toMatchObject({ path: expect.any(String), action: expect.any(String) });
    expect(result.coverage.mode).toBe("nice");
    expect(["running", "final"]).toContain(result.phase);
    // The band renders these as the digest's receipt; an empty one would render as a disclosure
    // that opens onto nothing.
    expect(result.reasoning.every((thought) => thought.length > 0)).toBe(true);
    expect(result.filesTouched.map((file) => file.action)).toEqual(["edited", "wrote"]);
  });

  it("carries the sidecar's error code down the stream rather than a generic failure", () => {
    const transport = new FakeHttpTransport();
    const messages: SummaryStreamMessage[] = [];
    new SidecarDataSource(transport).summarizeTurn(
      { source: "pi", sessionId: "s1" },
      { onMessage: (message) => messages.push(message), onError: () => {} },
    );
    // A run can only fail after the response is committed as a 200 event-stream, so the code
    // travels in the body. The panel branches on it exactly as it did on a status.
    transport.deliver("/summary", {
      type: "error",
      error: { code: "summary-unconfigured", message: "no model credential", retryable: false },
    });

    expect(messages).toEqual([{
      type: "error",
      error: { code: "summary-unconfigured", message: "no model credential", retryable: false },
    }]);
  });

  it("streams the reasoning before the digest", () => {
    const transport = new FakeHttpTransport();
    const messages: SummaryStreamMessage[] = [];
    new SidecarDataSource(transport).summarizeTurn(
      { source: "pi", sessionId: "s1" },
      { onMessage: (message) => messages.push(message), onError: () => {} },
    );
    transport.deliver("/summary", { type: "thinking-delta", text: "Read " });
    transport.deliver("/summary", { type: "thinking-delta", text: "the runtime." });
    transport.deliver("/summary", { type: "reasoning", text: "Read the runtime." });

    expect(messages.map((message) => message.type))
      .toEqual(["thinking-delta", "thinking-delta", "reasoning"]);
  });

  it("reads the config body the summarize button gates on", async () => {
    const transport = new FakeHttpTransport();
    transport.responses.set("GET /api/config", {
      status: 200,
      body: JSON.stringify({
        staleThresholdMs: 1, readyThresholdMs: 1, liveWindowMs: 1,
        watcherState: "live", sessionCount: 3,
        summaryEnabled: true, summaryModel: "opencode-go/deepseek-v4-flash",
      }),
    });
    const config = await new SidecarDataSource(transport).fetchConfig();
    expect(config.summaryEnabled).toBe(true);
    expect(config.summaryModel).toBe("opencode-go/deepseek-v4-flash");
  });
});
