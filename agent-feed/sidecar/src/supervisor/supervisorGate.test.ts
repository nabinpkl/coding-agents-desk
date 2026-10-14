import { describe, expect, test } from "bun:test";
import { createSupervisorGate, type SupervisorState } from "@/supervisor/supervisorGate";

const ROUTES = "/repo/agent-feed/sidecar/src/http/sessionRoutes.ts";
const CONFIG = "/repo/agent-feed/sidecar/src/config.ts";

function gate(quietMs = 0) {
  const restarts: string[] = [];
  const logs: string[] = [];
  const published: SupervisorState[] = [];
  const it = createSupervisorGate({
    restart: (reason) => restarts.push(reason),
    log: (message) => logs.push(message),
    publish: (state) => published.push(state),
  }, { quietMs });
  return { it, restarts, logs, published };
}

test("a change that parses replaces the sidecar", () => {
  const { it, restarts } = gate();
  it.changed([{ path: ROUTES, failure: null }]);
  expect(restarts).toEqual(["1 changed file parses"]);
  expect(it.state()).toEqual({ held: false, blocked: null, mode: "auto" });
});

test("a half-written file leaves the running sidecar alone, and says why", () => {
  const { it, restarts, logs } = gate();
  it.changed([{ path: ROUTES, failure: "Unexpected end of file" }]);

  expect(restarts).toEqual([]);
  expect(it.state()).toEqual({
    held: true,
    blocked: "sessionRoutes.ts: Unexpected end of file",
    mode: "auto",
  });
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("Unexpected end of file");
});

test("finishing the edit is what releases it", () => {
  const { it, restarts } = gate();
  it.changed([{ path: ROUTES, failure: "Unexpected end of file" }]);
  it.changed([{ path: ROUTES, failure: null }]);
  expect(restarts).toEqual(["1 changed file parses"]);
  expect(it.state()).toEqual({ held: false, blocked: null, mode: "auto" });
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
  expect(published.at(-1)).toEqual({
    held: true,
    blocked: "sessionRoutes.ts: Syntax Error",
    mode: "auto",
  });
  it.changed([{ path: ROUTES, failure: null }]);
  expect(published.at(-1)).toEqual({ held: false, blocked: null, mode: "auto" });
});

test("an empty batch decides nothing", () => {
  const { it, restarts, published } = gate();
  it.changed([]);
  expect(restarts).toEqual([]);
  expect(published).toEqual([]);
});

// The reader's own half of the question, which the parse cannot answer for them: a tree that parses
// perfectly is still a restart, and a restart takes every stream the panel is holding with it.
test("leaves a tree that parses alone while the reader has asked it to wait", () => {
  const { it, restarts, published } = gate();
  it.setMode("manual");
  it.changed([{ path: ROUTES, failure: null }]);
  expect(restarts).toEqual([]);
  expect(it.state()).toEqual({ held: true, blocked: null, mode: "manual" });
  // Held with nothing broken is the shape the panel row reads to say "waiting" rather than "stuck".
  expect(published.at(-1)?.blocked).toBeNull();
});

test("says it is waiting every round, the way it says it is holding", () => {
  const { it, logs } = gate();
  it.setMode("manual");
  it.changed([{ path: ROUTES, failure: null }]);
  it.changed([{ path: CONFIG, failure: null }]);
  // One line for the mode change, one per batch: a reader going backwards through the log sees it
  // was waiting the whole time rather than once.
  expect(logs.filter((line) => line.includes("waiting to be asked"))).toHaveLength(2);
});

test("takes the tree when the reader asks, and stays in manual", () => {
  const { it, restarts } = gate();
  it.setMode("manual");
  it.changed([{ path: ROUTES, failure: null }]);
  expect(it.apply()).toBe(true);
  expect(restarts).toEqual(["asked for from the panel"]);
  expect(it.state()).toEqual({ held: false, blocked: null, mode: "manual" });
});

test("refuses to take a tree with half a file in it, however it was asked", () => {
  const { it, restarts } = gate();
  it.setMode("manual");
  it.changed([{ path: ROUTES, failure: "Unexpected end of file" }]);
  expect(it.apply()).toBe(false);
  it.setMode("auto");
  expect(restarts).toEqual([]);
  expect(it.state().blocked).toBe("sessionRoutes.ts: Unexpected end of file");
});

test("restarts nothing when there is nothing waiting", () => {
  const { it, restarts } = gate();
  it.setMode("manual");
  expect(it.apply()).toBe(false);
  expect(restarts).toEqual([]);
});

test("coming back to auto is itself the yes the tree was waiting for", () => {
  const { it, restarts } = gate();
  it.setMode("manual");
  it.changed([{ path: ROUTES, failure: null }]);
  it.setMode("auto");
  expect(restarts).toEqual(["live updates back on, and the tree parses"]);
  expect(it.state()).toEqual({ held: false, blocked: null, mode: "auto" });
});

test("hears the same mode over and over without deciding anything", () => {
  // The supervisor re-reads the panel's standing request on a timer, so this arrives every second.
  const { it, restarts, published } = gate();
  it.setMode("auto");
  it.setMode("auto");
  expect(restarts).toEqual([]);
  expect(published).toEqual([]);
});

// Every file whole and the tree still will not start: the caller saved before its callee. The
// restart would stop the running sidecar to free the port and then die at startup, so nothing would
// serve until a later save; holding keeps the old one serving instead.
test("a tree that parses but will not link leaves the running sidecar alone, and says why", () => {
  const { it, restarts, logs } = gate();
  it.changed([{ path: ROUTES, failure: null }], 'server.ts:8: No matching export in "src/http/sessionRoutes.ts" for import "createRoutes"');
  expect(restarts).toEqual([]);
  expect(it.state()).toEqual({
    held: true,
    blocked: 'server.ts:8: No matching export in "src/http/sessionRoutes.ts" for import "createRoutes"',
    mode: "auto",
  });
  expect(logs[0]).toContain("No matching export");
});

// The fix to a link failure is usually a DIFFERENT file from the one that broke it -- the callee,
// saved after the caller -- so it is cleared by the next tree that links, not by its own path.
test("the save that makes the tree link is what releases it, whichever file that is", () => {
  const { it, restarts } = gate();
  it.changed([{ path: ROUTES, failure: null }], "server.ts:8: No matching export");
  it.changed([{ path: CONFIG, failure: null }], null);
  expect(restarts).toEqual(["1 changed file parses"]);
  expect(it.state()).toEqual({ held: false, blocked: null, mode: "auto" });
});

test("a half-written file is named ahead of a link failure, since it is the likelier cause", () => {
  const { it } = gate();
  it.changed([{ path: ROUTES, failure: "Unexpected end of file" }], "server.ts:8: Could not resolve");
  expect(it.state().blocked).toBe("sessionRoutes.ts: Unexpected end of file");
});

test("refuses to take a tree that will not link when the reader asks, or on coming back to auto", () => {
  const { it, restarts } = gate();
  it.setMode("manual");
  it.changed([{ path: ROUTES, failure: null }], "server.ts:8: Could not resolve");
  expect(it.apply()).toBe(false);
  it.setMode("auto");
  expect(restarts).toEqual([]);
});

// An agent's change is several saves across the sidecar and the panel. Restarting on the first of
// them puts the panel against a sidecar it does not match, so a whole tree waits for both to stop.
describe("the quiet window", () => {
  const QUIET = 3_000;
  const PANEL_QUIET = { changedAt: 0, blocked: null };

  test("a whole tree waits for its own edits to settle, and says so", () => {
    const { it, restarts } = gate(QUIET);
    it.changed([{ path: ROUTES, failure: null }], null, 10_000, PANEL_QUIET);
    expect(restarts).toEqual([]);
    expect(it.state()).toEqual({ held: true, blocked: "waiting for edits to settle", mode: "auto" });
    it.tick(12_999, PANEL_QUIET);
    expect(restarts).toEqual([]);
    it.tick(13_000, PANEL_QUIET);
    expect(restarts).toEqual(["1 changed file parses"]);
    expect(it.state()).toEqual({ held: false, blocked: null, mode: "auto" });
  });

  test("another save inside the window starts it again", () => {
    const { it, restarts } = gate(QUIET);
    it.changed([{ path: ROUTES, failure: null }], null, 10_000, PANEL_QUIET);
    it.changed([{ path: CONFIG, failure: null }], null, 12_000, PANEL_QUIET);
    it.tick(13_500, PANEL_QUIET);
    expect(restarts).toEqual([]);
    it.tick(15_000, PANEL_QUIET);
    expect(restarts).toEqual(["1 changed file parses"]);
  });

  test("waits for the panel's edits to settle too", () => {
    const { it, restarts } = gate(QUIET);
    it.changed([{ path: ROUTES, failure: null }], null, 10_000, PANEL_QUIET);
    it.tick(13_000, { changedAt: 12_000, blocked: null });
    expect(restarts).toEqual([]);
    expect(it.state().blocked).toBe("waiting for the panel's edits to settle");
    it.tick(15_000, { changedAt: 12_000, blocked: null });
    expect(restarts).toEqual(["1 changed file parses"]);
  });

  test("does not restart under a panel with a half-written file, and names it", () => {
    const { it, restarts } = gate(QUIET);
    const broken = { changedAt: 0, blocked: "BotCanvasCard.tsx: Unexpected end of file" };
    it.changed([{ path: ROUTES, failure: null }], null, 10_000, broken);
    it.tick(60_000, broken);
    expect(restarts).toEqual([]);
    expect(it.state().blocked).toBe("waiting for the panel: BotCanvasCard.tsx: Unexpected end of file");
    it.tick(61_000, PANEL_QUIET);
    expect(restarts).toEqual(["1 changed file parses"]);
  });

  // A peer, a bundled panel, a dev server that stopped: there is no panel to wait for, and waiting on
  // one would hold the sidecar forever.
  test("with no panel saying anything, waits on its own tree alone", () => {
    const { it, restarts } = gate(QUIET);
    it.changed([{ path: ROUTES, failure: null }], null, 10_000, null);
    it.tick(13_000, null);
    expect(restarts).toEqual(["1 changed file parses"]);
  });

  test("publishes the wait once, not on every tick", () => {
    const { it, published } = gate(QUIET);
    it.changed([{ path: ROUTES, failure: null }], null, 10_000, PANEL_QUIET);
    const before = published.length;
    it.tick(11_000, PANEL_QUIET);
    it.tick(12_000, PANEL_QUIET);
    expect(published.length).toBe(before);
  });

  test("the reader's own yes does not wait", () => {
    const { it, restarts } = gate(QUIET);
    it.setMode("manual");
    it.changed([{ path: ROUTES, failure: null }], null, 10_000, PANEL_QUIET);
    expect(it.apply()).toBe(true);
    expect(restarts).toEqual(["asked for from the panel"]);
  });

  test("ticks decide nothing under manual, or for a tree that is not whole", () => {
    const { it, restarts } = gate(QUIET);
    it.changed([{ path: ROUTES, failure: "Unexpected end of file" }], null, 10_000, PANEL_QUIET);
    it.tick(60_000, PANEL_QUIET);
    it.setMode("manual");
    it.changed([{ path: ROUTES, failure: null }], null, 61_000, PANEL_QUIET);
    it.tick(90_000, PANEL_QUIET);
    expect(restarts).toEqual([]);
  });
});
