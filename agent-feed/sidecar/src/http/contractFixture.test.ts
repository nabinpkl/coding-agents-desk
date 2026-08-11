// The sidecar's half of the shared wire contract.
//
// `agent-feed/wire/contract-fixture.json` is one document read by two suites: this one asserts the
// sidecar's routes emit exactly those bodies, and the panel's asserts its data source parses them
// into what the view renders. Per-side fixtures are what hid the last drift -- both suites were
// green while the two shapes disagreed in production -- so the fixture is deliberately one file
// that neither side owns alone.
//
// A change here fails whichever side did not intend it: edit the sidecar's output and this test
// fails until the fixture is updated; update the fixture and the panel's test fails unless it can
// still read it.

import { afterEach, expect, test } from "bun:test";
import type { AgentBackend, AgentSessionDescriptor } from "../agents/agentBackend.ts";
import type {
  ActivityEvent,
  AgentCommandReceipt,
  EventsPage,
  ProjectsPayload,
  SessionsPayload,
  TimelineMessage,
  WireErrorPayload,
} from "@agentdesk/agent-feed-wire";
import { state } from "../transcripts/transcriptState.ts";
import { createTimelineRoutes } from "./timelineRoutes.ts";
import fixture from "../../../wire/contract-fixture.json";

// Each body, named as the type it claims to be.
//
// Cast rather than `satisfies`: a JSON import widens every literal to its base type, so
// `"nice"` arrives as `string` and no structural check against a union like `EventMode` can pass.
// The contract is therefore asserted at runtime below -- which is where it matters anyway, since
// what these tests compare is the bytes a live route wrote against the bytes in this file.
const projects = fixture.projects as ProjectsPayload;
const sessions = fixture.sessions as SessionsPayload;
const snapshot = fixture.timelineSnapshot as TimelineMessage;
const upsert = fixture.timelineUpsert as TimelineMessage;
const tail = fixture.timelineTail as TimelineMessage;
const ui = fixture.timelineUi as TimelineMessage;
const streamError = fixture.timelineError as TimelineMessage;
const eventsPage = fixture.eventsPage as EventsPage;
const descriptor = fixture.sessionDescriptor as AgentSessionDescriptor;
const receipt = fixture.commandReceipt as AgentCommandReceipt;
const errorPayload = fixture.errorPayload as WireErrorPayload;

const server = { timeout() {} } as never;

/** A backend that answers exactly the fixture's snapshot, and nothing beyond it. */
function fixtureBackend(): AgentBackend {
  const events = (snapshot as { envelope: { events: ActivityEvent[] } }).envelope.events;
  return {
    id: "pi",
    capabilities: descriptor.capabilities,
    describeSession: () => descriptor,
    async createSession() {
      return descriptor;
    },
    async page(_sessionId, offset, limit) {
      return {
        events: events.slice(offset, offset + limit),
        total: events.length,
        mode: "nice",
        sequence: events.length,
        runState: "idle",
        queue: { steer: 0, followUp: 0 },
      };
    },
    async subscribe() {
      return () => {};
    },
    async send() {
      return receipt;
    },
    async abort() {
      return { requestId: receipt.requestId, delivery: "abort" };
    },
    async subscribeUi() {
      return () => {};
    },
    async respondToUi() {
      return "accepted";
    },
    async dispose() {},
  };
}

afterEach(() => {
  state.watcherState = "idle";
});

test("the timeline stream's opening message is the fixture's snapshot, byte for byte", async () => {
  state.watcherState = "live";
  const backend = fixtureBackend();
  const route = createTimelineRoutes(
    (id) => (id === backend.id ? backend : undefined),
    () => descriptor,
  );
  const request = new Request("http://localhost/api/sessions/pi/s1/timeline?mode=nice");
  const response = (await route(request, new URL(request.url), server)) as Response;

  const reader = response.body!.getReader();
  const { value } = await reader.read();
  const frame = new TextDecoder().decode(value);
  // Parsed rather than string-compared: the fixture is formatted for a human reader, and the
  // contract is the shape, not its whitespace.
  const message = JSON.parse(frame.slice(frame.indexOf("data: ") + 6).split("\n\n")[0]!);
  expect(message).toEqual(snapshot);
  await reader.cancel();
});

test("every fixture body is one of the wire's own message shapes", () => {
  // Cheap on its own, but it is what makes the fixture a contract rather than a blob: a message
  // type the panel added and the sidecar never emits fails here.
  expect(projects.projects[0]!.projectPath).toBe(sessions.projectPath);
  expect(sessions.sessions[0]!.capabilities).toEqual(descriptor.capabilities);
  expect([snapshot.type, upsert.type, tail.type, ui.type, streamError.type]).toEqual([
    "timeline",
    "timeline",
    "tail",
    "ui",
    "error",
  ]);
  expect(eventsPage.mode).toBe("nice");
  expect(receipt.delivery).toBe("immediate");
  expect(errorPayload.error.retryable).toBe(false);
});
