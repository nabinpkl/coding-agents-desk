/**
 * @vitest-environment node
 *
 * Node rather than this project's jsdom default, because the parser under test is esbuild and
 * jsdom's `TextEncoder` is not the one esbuild requires: it refuses to load at all under it, which
 * reads as the whole suite failing to collect rather than as an environment mismatch. This module
 * runs in the dev server and never touches a DOM, so there was nothing to gain from jsdom anyway.
 *
 * When the dev server hands a change to the page, and when it sits on it.
 *
 * The rule: a file that parses goes through at once, and a file that does not is held until a later
 * save completes it. What that decides is whether a reader's panel survives somebody else's
 * half-finished edit, so the parser is exercised against the real shapes an interrupted write makes
 * rather than assumed.
 */

import { describe, expect, it } from "vitest";
import {
  createPublishGate,
  parseFailure,
  type PublishReport,
  type SupervisorReport,
  type UpdateMode,
} from "@/app/dev-server/panelPublish";

const PANEL = "/repo/packages/AgentPanel/Web/src";
const MAIN = `${PANEL}/app/main.tsx`;

function gateWith(sidecars: SupervisorReport[] = [], remembered: UpdateMode = "auto") {
  const reports: PublishReport[] = [];
  const told: string[] = [];
  const kept: UpdateMode[] = [];
  let reloads = 0;
  const gate = createPublishGate({
    broadcast: (report) => reports.push(report),
    buildId: () => "abc1234+",
    sidecars: () => sidecars,
    reload: () => {
      reloads += 1;
    },
    tell: (command, machine) => told.push(machine === undefined ? command : `${command}:${machine}`),
    remembered: () => remembered,
    remember: (mode) => kept.push(mode),
  });
  return { gate, reports, told, kept, reloaded: () => reloads };
}

describe("the publish gate", () => {
  it("holds a file that will not parse and lets a whole one through", () => {
    const { gate } = gateWith();
    expect(gate.hold(MAIN, "Unexpected end of file")).toBe(true);
    expect(gate.report().held).toEqual(["main.tsx"]);
    expect(gate.report().blocked).toBe("main.tsx: Unexpected end of file");

    expect(gate.hold(MAIN, null)).toBe(false);
    expect(gate.report().held).toEqual([]);
    expect(gate.report().blocked).toBeNull();
  });

  // The save that completes a half-written file IS the update the reader is waiting for, so there
  // is nothing left to replay once it lands. That is the whole reason this shape has no timers.
  it("needs no second event to catch up once a file is whole again", () => {
    const { gate, reports } = gateWith();
    gate.hold(MAIN, "Expected identifier but found end of file");
    const before = reports.length;
    expect(gate.hold(MAIN, null)).toBe(false);
    expect(reports.length).toBe(before + 1);
    expect(reports.at(-1)?.held).toEqual([]);
  });

  it("says nothing new while a file stays broken the same way", () => {
    const { gate, reports } = gateWith();
    gate.hold(MAIN, "Unexpected end of file");
    const after = reports.length;
    // An editor writing the same broken text again should not push a report per keystroke.
    expect(gate.hold(MAIN, "Unexpected end of file")).toBe(true);
    expect(reports.length).toBe(after);
  });

  it("never holds a stylesheet, which cannot take a render down", () => {
    const { gate } = gateWith();
    expect(gate.hold(`${PANEL}/app/styles.css`, "nonsense")).toBe(false);
    expect(gate.report().held).toEqual([]);
  });

  it("names the first file still held, since the row has one line for it", () => {
    const { gate } = gateWith();
    gate.hold(MAIN, "Unexpected end of file");
    gate.hold(`${PANEL}/app/AppDialogs.tsx`, "Syntax Error");
    expect(gate.report().held).toEqual(["main.tsx", "AppDialogs.tsx"]);
    expect(gate.report().blocked).toBe("main.tsx: Unexpected end of file");
  });

  // The other process's gate, carried on the same report: the sidecar runs the working tree too, and
  // a reader looking at a feed with no new rows cannot otherwise tell it apart from a quiet session.
  it("carries what each machine's supervisor is holding", () => {
    const { gate } = gateWith([
      { machine: "oracle", held: true, blocked: "sessionRoutes.ts: Unexpected end of file", mode: "auto" },
    ]);
    expect(gate.report().sidecars).toEqual([
      { machine: "oracle", held: true, blocked: "sessionRoutes.ts: Unexpected end of file", mode: "auto" },
    ]);
  });

  // A machine that is merely running is not news, and every machine the panel can see answers.
  it("leaves out the machines that are running the tree they were given", () => {
    const { gate } = gateWith([
      { machine: "dev", held: false, blocked: null, mode: "auto" },
      { machine: "oracle", held: true, blocked: "half a file", mode: "auto" },
    ]);
    expect(gate.report().sidecars.map((sidecar) => sidecar.machine)).toEqual(["oracle"]);
  });

  it("says nothing at all when no machine is holding anything", () => {
    const { gate } = gateWith();
    expect(gate.report().sidecars).toEqual([]);
  });
});

// The reader's own answer to the question the parser cannot answer for them: whether a file that IS
// whole should arrive while they are in the middle of using the page. An update that parses is still
// a remount, and a reader watching a session through an edit storm did not ask for one every few
// seconds.
describe("holding updates for the reader", () => {
  it("starts on auto, because the dev loop's default is that an edit reaches the page", () => {
    const { gate } = gateWith();
    expect(gate.report().mode).toBe("auto");
    expect(gate.hold(MAIN, null)).toBe(false);
  });

  it("holds a file that parses perfectly well once the reader has asked it to", () => {
    const { gate } = gateWith();
    gate.setMode("manual");
    expect(gate.report().mode).toBe("manual");
    expect(gate.hold(MAIN, null)).toBe(true);
    expect(gate.report().held).toEqual(["main.tsx"]);
    // Nothing is WRONG with it, which is the difference the row and the Apply button both read.
    expect(gate.report().blocked).toBeNull();
  });

  it("says nothing new while the same whole file is saved again", () => {
    const { gate, reports } = gateWith();
    gate.setMode("manual");
    gate.hold(MAIN, null);
    const after = reports.length;
    expect(gate.hold(MAIN, null)).toBe(true);
    expect(reports.length).toBe(after);
  });

  // By a reload, because a withheld update is GONE rather than parked: Vite drops an update whose
  // module list came back empty, so there is nothing kept anywhere to replay.
  it("hands the queue over by reloading when the reader applies it", () => {
    const { gate, reports, reloaded } = gateWith();
    gate.setMode("manual");
    gate.hold(MAIN, null);
    expect(gate.apply()).toBe(true);
    expect(reloaded()).toBe(1);
    expect(gate.report().held).toEqual([]);
    expect(reports.at(-1)?.held).toEqual([]);
    // Applying is not the same as changing your mind about the mode.
    expect(gate.report().mode).toBe("manual");
  });

  it("refuses to apply onto a half-written file, which is the page this gate exists to prevent", () => {
    const { gate, reloaded } = gateWith();
    gate.setMode("manual");
    gate.hold(MAIN, null);
    gate.hold(`${PANEL}/app/AppDialogs.tsx`, "Unexpected end of file");
    expect(gate.apply()).toBe(false);
    expect(reloaded()).toBe(0);
    expect(gate.report().held).toEqual(["main.tsx", "AppDialogs.tsx"]);
    expect(gate.report().blocked).toBe("AppDialogs.tsx: Unexpected end of file");
  });

  it("applies nothing, and reloads nobody, when the queue is empty", () => {
    const { gate, reloaded } = gateWith();
    gate.setMode("manual");
    expect(gate.apply()).toBe(false);
    expect(reloaded()).toBe(0);
  });

  it("takes the queue when the reader comes back to auto, since that is the yes it was waiting for", () => {
    const { gate, reloaded } = gateWith();
    gate.setMode("manual");
    gate.hold(MAIN, null);
    gate.setMode("auto");
    expect(reloaded()).toBe(1);
    expect(gate.report()).toMatchObject({ mode: "auto", held: [], blocked: null });
  });

  it("keeps holding a broken file through the switch back, and says so", () => {
    const { gate, reloaded } = gateWith();
    gate.setMode("manual");
    gate.hold(MAIN, "Syntax Error");
    gate.setMode("auto");
    expect(reloaded()).toBe(0);
    expect(gate.report()).toMatchObject({ mode: "auto", blocked: "main.tsx: Syntax Error" });
  });

  it("reloads nobody on the way into manual, and says which mode is in force", () => {
    const { gate, reports, reloaded } = gateWith();
    gate.setMode("manual");
    expect(reloaded()).toBe(0);
    expect(reports.at(-1)?.mode).toBe("manual");
  });

  it("says nothing at all when asked for the mode it is already in", () => {
    const { gate, reports } = gateWith();
    gate.setMode("auto");
    expect(reports).toEqual([]);
  });

  // A restart is one of the things a reader is asking to be protected from when they choose to hold
  // updates, so forgetting the choice on one would undo the request at the moment it was wanted
  // most. Safe to carry because the strip says which mode is in force even with nothing waiting.
  it("comes back in the mode the reader last chose, not the default", () => {
    const { gate } = gateWith([], "manual");
    expect(gate.report().mode).toBe("manual");
    expect(gate.hold(MAIN, null)).toBe(true);
  });

  it("records each choice as it is made, and nothing else", () => {
    const { gate, kept } = gateWith();
    gate.setMode("manual");
    gate.apply();
    gate.setMode("manual");
    expect(kept).toEqual(["manual"]);
    gate.setMode("auto");
    expect(kept).toEqual(["manual", "auto"]);
  });

  // The mode is one switch for both halves: a reader asking for the page to stop changing under
  // them is not asking about only one of those. Taking what is held is not. A supervisor holds a
  // RESTART, which drops every stream the panel holds from it, so the panel's Apply moves no
  // sidecar and a restart goes only to the machine it names.
  it("passes the mode to every machine, and a restart only to the one named", () => {
    const { gate, told } = gateWith();
    gate.setMode("manual");
    expect(told).toEqual(["manual"]);
    gate.apply();
    expect(told).toEqual(["manual"]);
    gate.restartSidecar("oracle");
    expect(told).toEqual(["manual", "apply:oracle"]);
    gate.setMode("auto");
    expect(told).toEqual(["manual", "apply:oracle", "auto"]);
  });

  // A supervisor that restarted -- a host relaunch, a crash -- comes back on auto, and would then
  // quietly start replacing its sidecar under a reader who asked for the opposite.
  it("says it again to a machine that came back in the wrong mode", () => {
    const machine = { machine: "oracle", held: false, blocked: null, mode: "auto" as const };
    const { gate, told } = gateWith([machine]);
    gate.setMode("manual");
    gate.reconcile();
    expect(told).toEqual(["manual", "manual"]);
  });

  it("says nothing to machines that already agree", () => {
    const { gate, told } = gateWith([
      { machine: "oracle", held: false, blocked: null, mode: "auto" },
      { machine: "dev", held: true, blocked: null, mode: "auto" },
    ]);
    gate.reconcile();
    expect(told).toEqual([]);
  });

  // The half the mode deliberately does not widen: a style swap changes nothing a reader is in the
  // middle of doing, so holding one would delay it for no one's benefit.
  it("still never holds a stylesheet", () => {
    const { gate } = gateWith();
    gate.setMode("manual");
    expect(gate.hold(`${PANEL}/app/styles.css`, null)).toBe(false);
  });
});

// The instrument itself. A gate that misreads what a half-saved file looks like is a gate that
// holds working code or forwards broken code, and both are worse than no gate.
describe("reading whether a file is whole", () => {
  it("refuses the shapes an interrupted write actually leaves behind", async () => {
    expect(await parseFailure("a.tsx", "export const x = {\n")).toBeTruthy();
    expect(await parseFailure("a.ts", "export function a() {\n  const b = 1;\n")).toBeTruthy();
    expect(await parseFailure("a.tsx", "export const A = () => <div>hi;\n")).toBeTruthy();
  });

  it("says where it gave up, so the row points at a line", async () => {
    const failure = await parseFailure("a.ts", "export function a() {\n  const b = 1;\n");
    expect(failure).toMatch(/line \d+/);
  });

  // Deliberately not caught: neither tree typechecks at runtime, so a type error cannot take a page
  // down, and holding one would mean paying a resident typechecker to prevent nothing.
  it("passes a whole file that happens to have a type error", async () => {
    expect(await parseFailure("a.ts", "export const n: number = 'not a number';\n")).toBeNull();
    expect(await parseFailure("a.tsx", "export const A = () => <div>hi</div>;\n")).toBeNull();
  });
});
