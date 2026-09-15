import { expect, test } from "bun:test";
import { createSupervisorGate, type SupervisorState } from "@/supervisorGate";

const ROUTES = "/repo/agent-feed/sidecar/src/http/sessionRoutes.ts";
const CONFIG = "/repo/agent-feed/sidecar/src/config.ts";

function gate() {
  const restarts: string[] = [];
  const logs: string[] = [];
  const published: SupervisorState[] = [];
  const it = createSupervisorGate({
    restart: (reason) => restarts.push(reason),
    log: (message) => logs.push(message),
    publish: (state) => published.push(state),
  });
  return { it, restarts, logs, published };
}

test("a change that parses replaces the sidecar", () => {
  const { it, restarts } = gate();
  it.changed([{ path: ROUTES, failure: null }]);
  expect(restarts).toEqual(["1 changed file parses"]);
  expect(it.state()).toEqual({ held: false, blocked: null });
});

test("a half-written file leaves the running sidecar alone, and says why", () => {
  const { it, restarts, logs } = gate();
  it.changed([{ path: ROUTES, failure: "Unexpected end of file" }]);

  expect(restarts).toEqual([]);
  expect(it.state()).toEqual({ held: true, blocked: "sessionRoutes.ts: Unexpected end of file" });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("Unexpected end of file");
});

test("finishing the edit is what releases it", () => {
  const { it, restarts } = gate();
  it.changed([{ path: ROUTES, failure: "Unexpected end of file" }]);
  it.changed([{ path: ROUTES, failure: null }]);
  expect(restarts).toEqual(["1 changed file parses"]);
  expect(it.state()).toEqual({ held: false, blocked: null });
});

// A tool rewriting several files at once is one change, and one of them being mid-write is enough
// to make the whole tree not worth running.
test("one broken file in a batch holds the whole batch", () => {
  const { it, restarts } = gate();
  it.changed([
    { path: CONFIG, failure: null },
    { path: ROUTES, failure: "Syntax Error" },
  ]);
  expect(restarts).toEqual([]);
  expect(it.state().blocked).toBe("sessionRoutes.ts: Syntax Error");

  // And the fix to the one file releases the batch, including the file that was fine all along.
  it.changed([{ path: ROUTES, failure: null }]);
  expect(restarts).toEqual(["1 changed file parses"]);
});

test("says it is holding the tree back every round, not only the first", () => {
  const { it, logs } = gate();
  it.changed([{ path: ROUTES, failure: "Unexpected end of file" }]);
  it.changed([{ path: ROUTES, failure: "Unexpected end of file" }]);
  // Whoever reads this log is looking backwards from a sidecar that stopped changing, and needs to
  // see that it was refusing the whole time rather than once.
  expect(logs).toHaveLength(2);
});

test("publishes every state, so a held sidecar is visible and not only logged", () => {
  const { it, published } = gate();
  it.changed([{ path: ROUTES, failure: "Syntax Error" }]);
  expect(published.at(-1)).toEqual({ held: true, blocked: "sessionRoutes.ts: Syntax Error" });
  it.changed([{ path: ROUTES, failure: null }]);
  expect(published.at(-1)).toEqual({ held: false, blocked: null });
});

test("an empty batch decides nothing", () => {
  const { it, restarts, published } = gate();
  it.changed([]);
  expect(restarts).toEqual([]);
  expect(published).toEqual([]);
});

test("forcing a restart ignores what is broken", () => {
  const { it, restarts } = gate();
  it.changed([{ path: ROUTES, failure: "Syntax Error" }]);
  it.force("asked for by hand");
  expect(restarts).toEqual(["asked for by hand"]);
  expect(it.state()).toEqual({ held: false, blocked: null });
});
