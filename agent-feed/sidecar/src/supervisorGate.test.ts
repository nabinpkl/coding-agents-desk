import { expect, test } from "bun:test";
import { createSupervisorGate } from "@/supervisorGate";

/** What tsc writes under `--watch --pretty false`, which is the gate's only input. */
const FIRST = "[3:26:40 AM] Starting compilation in watch mode...";
const CHANGED = "[3:26:41 AM] File change detected. Starting incremental compilation...";
const GREEN = "[3:26:43 AM] Found 0 errors. Watching for file changes.";
const RED = "[3:26:43 AM] Found 2 errors. Watching for file changes.";
const ERROR_LINE = "src/http/sessionRoutes.ts(88,5): error TS2345: Argument of type 'null'.";

function gate() {
  const restarts: string[] = [];
  const logs: string[] = [];
  let aborts = 0;
  const it = createSupervisorGate({
    restart: (reason) => restarts.push(reason),
    abortRestart: () => {
      aborts += 1;
    },
    log: (message) => logs.push(message),
  });
  return { it, restarts, logs, aborts: () => aborts };
}

test("the first clean compile is not a change, so nothing is restarted for it", () => {
  const { it, restarts } = gate();
  it.readTypecheckLine(FIRST);
  it.readTypecheckLine(GREEN);
  expect(restarts).toEqual([]);
  expect(it.state()).toEqual({ dirty: false, checking: false, blocked: null });
});

test("an edit that typechecks replaces the sidecar", () => {
  const { it, restarts } = gate();
  it.readTypecheckLine(FIRST);
  it.readTypecheckLine(GREEN);
  it.readTypecheckLine(CHANGED);
  expect(restarts).toEqual([]);
  it.readTypecheckLine(GREEN);
  expect(restarts).toEqual(["the tree typechecks"]);
});

test("an edit that does not typecheck leaves the running sidecar alone, and says why", () => {
  const { it, restarts, logs } = gate();
  it.readTypecheckLine(CHANGED);
  it.readTypecheckLine(ERROR_LINE);
  it.readTypecheckLine(RED);

  expect(restarts).toEqual([]);
  expect(it.state().blocked).toBe(
    "src/http/sessionRoutes.ts(88,5): error TS2345: Argument of type 'null'.",
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("TS2345");

  // Still refusing on the next round, and still saying so: whoever reads this log is looking
  // backwards from a sidecar that stopped changing.
  it.readTypecheckLine(CHANGED);
  it.readTypecheckLine(ERROR_LINE);
  it.readTypecheckLine(RED);
  expect(logs).toHaveLength(2);
  expect(restarts).toEqual([]);
});

test("a broken tree that gets fixed restarts once, for the fix", () => {
  const { it, restarts } = gate();
  it.readTypecheckLine(CHANGED);
  it.readTypecheckLine(ERROR_LINE);
  it.readTypecheckLine(RED);
  it.readTypecheckLine(CHANGED);
  it.readTypecheckLine(GREEN);
  expect(restarts).toEqual(["the tree typechecks"]);
});

// The window this closes: a verdict is about the tree as the run began, so a write landing mid-run
// is unjudged. tsc starts another run for it, and that start takes the pending restart back.
test("a change arriving after a verdict takes the pending restart back", () => {
  const { it, aborts } = gate();
  it.readTypecheckLine(CHANGED);
  it.readTypecheckLine(GREEN);
  expect(aborts()).toBe(1);
  it.readTypecheckLine(CHANGED);
  expect(aborts()).toBe(2);
});

test("a count with no error line this can parse still says something true", () => {
  const { it, logs } = gate();
  it.readTypecheckLine(CHANGED);
  it.readTypecheckLine(RED);
  expect(logs[0]).toContain("2 typecheck errors");
});

test("forcing a restart ignores what the typechecker thinks", () => {
  const { it, restarts } = gate();
  it.readTypecheckLine(CHANGED);
  it.readTypecheckLine(ERROR_LINE);
  it.readTypecheckLine(RED);
  it.force("asked for by hand");

  expect(restarts).toEqual(["asked for by hand"]);
  expect(it.state()).toEqual({ dirty: false, checking: false, blocked: null });
});
