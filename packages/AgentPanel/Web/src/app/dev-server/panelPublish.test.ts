/**
 * @vitest-environment node
 *
 * Node rather than this project's jsdom default: this module runs in the dev server and never
 * touches a DOM, and the parser under test is the one the dev server runs, so it is tested in the
 * runtime the dev server has.
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
  neverLoaded,
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
    tell: (command) => told.push(command),
    remembered: () => remembered,
    remember: (mode) => kept.push(mode),
  });
  return { gate, reports, told, kept, reloaded: () => reloads };
}

describe("the publish gate", () => {
  // A whole file held on a type error is shown like one that will not parse, but it does not stop
  // the reader taking the tree: they asked, and code that does not typecheck often still runs.
  it("shows a file held on a type error, and lets the reader reload past it", () => {
    const { gate, reloaded } = gateWith();
    gate.setTypeHeld(new Map([[`${PANEL}/features/profile/useStaleSessions.ts`, "AgentPanelApp.tsx:105: Argument is wrong."]]));
    expect(gate.report().held).toEqual(["useStaleSessions.ts"]);
    expect(gate.report().blocked).toBe("useStaleSessions.ts waits on AgentPanelApp.tsx:105: Argument is wrong.");

    expect(gate.apply()).toBe(true);
    expect(reloaded()).toBe(1);
    expect(gate.report().held).toEqual([]);
    expect(gate.report().blocked).toBeNull();
  });

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
      { machine: "oracle", held: true, blocked: "sessionRoutes.ts: Unexpected end of file", mode: "auto", behind: false },
    ]);
    expect(gate.report().sidecars).toEqual([
      { machine: "oracle", held: true, blocked: "sessionRoutes.ts: Unexpected end of file", mode: "auto", behind: false },
    ]);
  });

  // A machine that is merely running is not news, and every machine the panel can see answers.
  it("leaves out the machines that are running the tree they were given", () => {
    const { gate } = gateWith([
      { machine: "dev", held: false, blocked: null, mode: "auto", behind: false },
      { machine: "oracle", held: true, blocked: "half a file", mode: "auto", behind: false },
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
  // them is not asking about only one of those. Taking what is held is two: a supervisor holds a
  // RESTART, which drops every stream the panel holds from it, so the panel's Apply moves no
  // sidecar and the sidecars restart on their own command, every machine together.
  it("passes the mode and a restart to every machine, and a panel apply to none", () => {
    const { gate, told } = gateWith();
    gate.setMode("manual");
    expect(told).toEqual(["manual"]);
    gate.apply();
    expect(told).toEqual(["manual"]);
    gate.restartSidecars();
    expect(told).toEqual(["manual", "apply"]);
    gate.setMode("auto");
    expect(told).toEqual(["manual", "apply", "auto"]);
  });

  // A supervisor that restarted -- a host relaunch, a crash -- comes back on auto, and would then
  // quietly start replacing its sidecar under a reader who asked for the opposite.
  it("says it again to a machine that came back in the wrong mode", () => {
    const machine = { machine: "oracle", held: false, blocked: null, mode: "auto" as const, behind: false };
    const { gate, told } = gateWith([machine]);
    gate.setMode("manual");
    gate.reconcile();
    expect(told).toEqual(["manual", "manual"]);
  });

  it("says nothing to machines that already agree", () => {
    const { gate, told } = gateWith([
      { machine: "oracle", held: false, blocked: null, mode: "auto", behind: false },
      { machine: "dev", held: true, blocked: null, mode: "auto", behind: false },
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

// The supervisor waits for the panel's edits to settle before restarting the sidecar, and hears
// about them only through this. The panel itself never waits on the sidecar.
describe("telling this Mac's sidecar supervisor what the panel's tree is doing", () => {
  function reporting() {
    const activity: { changedAt: number; blocked: string | null }[] = [];
    const gate = createPublishGate({
      broadcast: () => {},
      buildId: () => "abc1234+",
      sidecars: () => [],
      reload: () => {},
      tell: () => {},
      remembered: () => "auto",
      remember: () => {},
      recordActivity: (each) => activity.push(each),
    });
    return { gate, activity };
  }

  it("says when a panel file last changed, and whether one will not parse", () => {
    const { gate, activity } = reporting();
    gate.hold(MAIN, "Unexpected end of file", 5_000);
    expect(activity.at(-1)).toEqual({ changedAt: 5_000, blocked: "main.tsx: Unexpected end of file" });
    expect(gate.hold(MAIN, null, 6_000)).toBe(false);
    expect(activity.at(-1)).toEqual({ changedAt: 6_000, blocked: null });
  });

  it("says it again on the heartbeat, so a quiet panel is not read as a gone one", () => {
    const { gate, activity } = reporting();
    gate.hold(MAIN, null, 6_000);
    gate.heartbeat();
    expect(activity).toHaveLength(2);
    expect(activity.at(-1)).toEqual({ changedAt: 6_000, blocked: null });
  });
});

// Files the page never runs sit in the module graph only because Tailwind scanned them; an update to
// one has nobody to reach, and letting it through reloaded every open panel.
describe("an update to a file the page never loaded", () => {
  const stylesheet = { file: `${PANEL}/app/styles.css` };
  const component = { file: `${PANEL}/features/bots/cards/BotCanvasCard.tsx` };
  const node = (imports: number, importers: { file: string }[]) =>
    ({ importedModules: new Set(Array.from({ length: imports })), importers: new Set(importers) }) as unknown as Parameters<typeof neverLoaded>[0];

  it("is dropped for a test, a harness or a type-only module, which only the stylesheet points at", () => {
    expect(neverLoaded(node(0, [stylesheet]))).toBe(true);
  });

  it("goes through for a module a page imports", () => {
    expect(neverLoaded(node(0, [component, stylesheet]))).toBe(false);
  });

  // The entry has no importer at all; what marks it loaded is that it compiled and recorded imports.
  it("goes through for the entry, which nothing imports but which has imports of its own", () => {
    expect(neverLoaded(node(4, [stylesheet]))).toBe(false);
  });
});
