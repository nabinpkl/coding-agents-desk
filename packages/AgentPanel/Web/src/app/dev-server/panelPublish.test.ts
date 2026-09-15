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

function gateWith(mtimes: Record<string, number> = {}) {
  const released: string[] = [];
  const reports: PublishReport[] = [];
  const warnings: string[] = [];
  const gate = createPublishGate({
    modifiedAt: (file) => mtimes[file] ?? 0,
    release: (file) => released.push(file),
    broadcast: (report) => reports.push(report),
    warn: (message) => warnings.push(message),
    buildId: () => "abc1234+",
  });
  return { gate, released, reports, warnings };
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
    const { gate, released } = gateWith();
    gate.readTypecheckLine(STARTED);
    gate.hold(`${PANEL}/app/main.tsx`);
    gate.hold(`${PANEL}/features/profile/panelBuild.ts`);
    expect(released).toEqual([]);

    gate.readTypecheckLine(GREEN);
    expect(released).toEqual([`${PANEL}/app/main.tsx`, `${PANEL}/features/profile/panelBuild.ts`]);
    expect(gate.report().held).toEqual([]);
    expect(gate.report().blocked).toBeNull();
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
  it("leaves a file saved after the check began for the next check", () => {
    const early = `${PANEL}/app/main.tsx`;
    const late = `${PANEL}/app/AppDialogs.tsx`;
    const { gate, released } = gateWith({ [early]: 0, [late]: Date.now() + 10_000 });
    gate.readTypecheckLine(STARTED);
    gate.hold(early);
    gate.hold(late);
    gate.readTypecheckLine(GREEN);

    expect(released).toEqual([early]);
    expect(gate.report().held).toEqual(["AppDialogs.tsx"]);
  });

  it("hands everything over when a caller says so, unjudged files included", () => {
    const late = `${PANEL}/app/main.tsx`;
    const { gate, released } = gateWith({ [late]: Date.now() + 10_000 });
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
    const { gate, released, warnings } = gateWith({ [file]: Date.now() + 10_000 });
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
