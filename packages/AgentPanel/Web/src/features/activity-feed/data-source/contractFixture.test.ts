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
    source.subscribeProjects((next) => projects.push(...next));
    transport.deliver("/api/projects/stream", JSON.stringify(fixture.projects));
    expect(projects).toEqual(fixture.projects.projects);

    const sessions: unknown[] = [];
    source.subscribeProjectSessions(fixture.sessions.projectPath, (next) => sessions.push(...next));
    transport.deliver("/api/sessions/stream", JSON.stringify(fixture.sessions));
    expect(sessions).toEqual(fixture.sessions.sessions);

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
