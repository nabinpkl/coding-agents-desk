/**
 * When the dev server hands a change to the page, and when it sits on it.
 *
 * Every decision here is a race with something -- a save that lands mid-typecheck, a green verdict
 * about a tree that has already moved on, a typechecker that dies -- and none of them is reachable
 * by starting a real dev server and editing a file. What they decide is whether a reader's panel
 * goes blank, so they are driven directly.
 */

import { describe, expect, it } from "vitest";
import { createPublishGate, type PublishReport } from "@/app/dev-server/panelPublish";

const PANEL = "/repo/packages/AgentPanel/Web/src";

function gateWith() {
  const released: string[] = [];
  const reports: PublishReport[] = [];
  const warnings: string[] = [];
  /** The handover the gate has decided on but not performed. Fired by hand, so a race is testable. */
  let deferred: (() => void) | null = null;
  const gate = createPublishGate({
    defer: (run) => {
      deferred = run;
      return () => {
        deferred = null;
      };
    },
    release: (file) => released.push(file),
    broadcast: (report) => reports.push(report),
    warn: (message) => warnings.push(message),
    buildId: () => "abc1234+",
  });
  return {
    gate,
    released,
    reports,
    warnings,
    pending: () => deferred !== null,
    settle: () => {
      const run = deferred;
      deferred = null;
      run?.();
    },
  };
}

/** What tsc writes under `--watch --pretty false`, which is what the gate reads. */
const STARTED = "[3:26:41 AM] File change detected. Starting incremental compilation...";
const GREEN = "[3:26:43 AM] Found 0 errors. Watching for file changes.";
const RED = "[3:26:43 AM] Found 1 error. Watching for file changes.";
const ERROR_LINE = `${PANEL}/app/main.tsx(12,3): error TS2304: Cannot find name 'Foo'.`;

describe("the publish gate", () => {
  it("holds source and lets a stylesheet through", () => {
    const { gate } = gateWith();
    expect(gate.hold(`${PANEL}/app/main.tsx`)).toBe(true);
    expect(gate.hold(`${PANEL}/app/styles.css`)).toBe(false);
    expect(gate.report().held).toEqual(["main.tsx"]);
  });

  it("hands over what it is holding once the tree typechecks", () => {
    const { gate, released, settle } = gateWith();
    gate.readTypecheckLine(STARTED);
    gate.hold(`${PANEL}/app/main.tsx`);
    gate.hold(`${PANEL}/features/profile/panelBuild.ts`);
    expect(released).toEqual([]);

    gate.readTypecheckLine(GREEN);
    settle();
    expect(released).toEqual([`${PANEL}/app/main.tsx`, `${PANEL}/features/profile/panelBuild.ts`]);
    expect(gate.report().held).toEqual([]);
    expect(gate.report().blocked).toBeNull();
  });

  it("waits for nothing when it is holding nothing", () => {
    const { gate, pending } = gateWith();
    gate.readTypecheckLine(STARTED);
    gate.readTypecheckLine(GREEN);
    expect(pending()).toBe(false);
  });

  it("keeps holding while the tree does not compile, and says what is in the way", () => {
    const { gate, released } = gateWith();
    gate.readTypecheckLine(STARTED);
    gate.hold(`${PANEL}/app/main.tsx`);
    gate.readTypecheckLine(ERROR_LINE);
    gate.readTypecheckLine(RED);

    expect(released).toEqual([]);
    const report = gate.report();
    expect(report.held).toEqual(["main.tsx"]);
    expect(report.checking).toBe(false);
    // The file's own name, not the absolute path: the row is one line wide.
    expect(report.blocked).toBe("main.tsx(12,3): error TS2304: Cannot find name 'Foo'.");
  });

  // The window this closes: a save lands while the typechecker is mid-run, so the green verdict it
  // then reports was never about that file. Publishing it there is the original bug, one race late.
  // The next run's START is what takes the handover back, rather than any judgement about the file.
  it("takes back a handover when the tree moves again before it happens", () => {
    const { gate, released, pending, settle } = gateWith();
    gate.readTypecheckLine(STARTED);
    gate.hold(`${PANEL}/app/main.tsx`);
    gate.readTypecheckLine(GREEN);
    expect(pending()).toBe(true);

    gate.readTypecheckLine(STARTED);
    expect(pending()).toBe(false);
    expect(released).toEqual([]);
    expect(gate.report().held).toEqual(["main.tsx"]);

    // The run that supersedes it is what decides, and it hands over both rounds' work.
    gate.readTypecheckLine(GREEN);
    settle();
    expect(released).toEqual([`${PANEL}/app/main.tsx`]);
    expect(gate.report().held).toEqual([]);
  });

  // The state the mtime comparison this replaced could get stuck in: restore a file to its previous
  // contents and tsc sees no change at all, so it never runs again, so nothing ever clears the hold.
  it("hands over a change that leaves the tree exactly as the typechecker last saw it", () => {
    const file = `${PANEL}/app/main.tsx`;
    const { gate, released, settle } = gateWith();
    gate.readTypecheckLine(STARTED);
    gate.hold(file);
    gate.readTypecheckLine(GREEN);
    // Nothing follows: no further run, no further verdict, because the text did not change.
    settle();
    expect(released).toEqual([file]);
    expect(gate.report().held).toEqual([]);
  });

  it("hands everything over when a caller says so, unjudged files included", () => {
    const late = `${PANEL}/app/main.tsx`;
    const { gate, released } = gateWith();
    gate.readTypecheckLine(STARTED);
    gate.hold(late);
    gate.readTypecheckLine(RED);
    expect(released).toEqual([]);

    gate.publish();
    expect(released).toEqual([late]);
    expect(gate.report().held).toEqual([]);
  });

  // The replay is a change event the gate asked for. Holding it again would deadlock the file.
  it("lets a released file through once, and holds its next change", () => {
    const file = `${PANEL}/app/main.tsx`;
    const { gate } = gateWith();
    gate.hold(file);
    gate.publish();
    expect(gate.hold(file)).toBe(false);
    expect(gate.hold(file)).toBe(true);
  });

  it("stops gating rather than stopping the dev loop when the typechecker dies", () => {
    const file = `${PANEL}/app/main.tsx`;
    const { gate, released, warnings } = gateWith();
    gate.hold(file);
    gate.giveUp("the typechecker exited with 1");

    expect(released).toEqual([file]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unfiltered");
    expect(gate.report().unfiltered).toBe(true);
    // And from here nothing is held back, because there is no longer anything that could clear it.
    expect(gate.hold(file)).toBe(false);
    gate.giveUp("again");
    expect(warnings).toHaveLength(1);
  });

  it("tells every page each time it starts holding something", () => {
    const { gate, reports } = gateWith();
    gate.hold(`${PANEL}/app/main.tsx`);
    expect(reports.at(-1)?.held).toEqual(["main.tsx"]);
    expect(reports.at(-1)?.build).toBe("abc1234+");
  });
});
