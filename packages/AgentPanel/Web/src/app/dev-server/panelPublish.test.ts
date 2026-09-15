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
} from "@/app/dev-server/panelPublish";

const PANEL = "/repo/packages/AgentPanel/Web/src";
const MAIN = `${PANEL}/app/main.tsx`;

function gateWith(sidecar: SupervisorReport | null = null) {
  const reports: PublishReport[] = [];
  const gate = createPublishGate({
    broadcast: (report) => reports.push(report),
    buildId: () => "abc1234+",
    sidecar: () => sidecar,
  });
  return { gate, reports };
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
  it("carries what the sidecar's own supervisor is holding", () => {
    const { gate } = gateWith({ held: true, blocked: "sessionRoutes.ts: Unexpected end of file" });
    expect(gate.report().sidecar).toEqual({
      held: true,
      blocked: "sessionRoutes.ts: Unexpected end of file",
    });
  });

  it("says nothing about a sidecar that has no supervisor behind it", () => {
    const { gate } = gateWith();
    expect(gate.report().sidecar).toBeNull();
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
