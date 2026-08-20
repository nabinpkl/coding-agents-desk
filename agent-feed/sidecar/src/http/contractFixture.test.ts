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
  SummaryResult,
  TimelineMessage,
  UsageReport,
  WireErrorPayload,
} from "@agentdesk/agent-feed-wire";
import { state } from "../transcripts/transcriptState.ts";
import { createSummaryRoutes } from "./summaryRoutes.ts";
import { createTimelineRoutes } from "./timelineRoutes.ts";
import { createUsageRoutes } from "./usageRoutes.ts";
import { config } from "../config.ts";
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
const summaryResult = fixture.summaryResult as SummaryResult;
const usageReport = fixture.usageReport as UsageReport;

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

test("the summary route emits the fixture's digest, field for field", async () => {
  state.watcherState = "live";
  const wasEnabled = config.summaryEnabled;
  (config as unknown as { summaryEnabled: boolean }).summaryEnabled = true;
  try {
    const backend = fixtureBackend();
    const route = createSummaryRoutes(
      (id) => (id === backend.id ? backend : undefined),
      () => descriptor,
      { async run() { return summaryResult; } },
    );
    const request = new Request("http://localhost/api/sessions/pi/s1/summary");
    const response = (await route(request, new URL(request.url), server)) as Response;
    expect(response.status).toBe(200);
    const last = (await response.text())
      .split("\n\n")
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice("data: ".length)))
      .at(-1);
    // Field for field, not field-by-field: a route that quietly added or dropped a key would
    // still satisfy a spot check, and the panel reads this body as the whole contract.
    expect(last).toEqual({ type: "result", result: summaryResult });
  } finally {
    (config as unknown as { summaryEnabled: boolean }).summaryEnabled = wasEnabled;
  }
});

test("the fixture's digest is internally consistent", () => {
  // `phase` and `runState` are set from the same fact by the runner, so a fixture that
  // disagrees with itself would let a panel render "still running" over a finished turn.
  expect(summaryResult.phase).toBe(summaryResult.runState === "running" ? "running" : "final");
  expect(summaryResult.coverage.mode).toBe("nice");
  // The reasoning is observed from the session's events, never asked of the model, so an empty
  // entry would mean the recorder read the wrong field off the event.
  for (const thought of summaryResult.reasoning) expect(thought.length).toBeGreaterThan(0);
  // Files come from the turn's own calls, so every entry says what the turn did to it.
  for (const file of summaryResult.filesTouched) {
    expect(["wrote", "edited", "deleted"]).toContain(file.action);
    expect(file.edits).toBeGreaterThan(0);
  }
  expect(summaryResult.coverage.fromEventIndex).toBeLessThanOrEqual(summaryResult.coverage.toEventIndex);
});

test("the usage route emits the fixture's report, field for field", async () => {
  const route = createUsageRoutes({ cached: () => null, scan: async () => usageReport });
  const request = new Request("http://localhost/api/usage");
  const response = (await route(request, new URL(request.url), server)) as Response;
  expect(response.status).toBe(200);
  const messages = (await response.text())
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)));
  expect(messages).toEqual([{ type: "report", report: usageReport }, { type: "settled" }]);
});

test("the fixture's usage report is internally consistent", () => {
  const codex = usageReport.vendors[0]!;
  for (const day of codex.days) {
    // The one invariant the whole feature rests on: cached input is a SUBSET of input, never a
    // number to be added to it. A fixture that broke this would bless the inflating bug.
    expect(day.totals.cachedInputTokens).toBeLessThanOrEqual(day.totals.inputTokens);
    expect(day.totals.reasoningTokens).toBeLessThanOrEqual(day.totals.outputTokens);
    // A day's split has to account for the day, or the detail rows and the cell disagree.
    const summed = day.byModel.reduce((total, entry) => total + entry.totals.inputTokens, 0);
    expect(summed).toBe(day.totals.inputTokens);
    expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
  expect(codex.coverage.from).toBe(codex.days[0]!.date);
});
