import { expect, test } from "vitest";
import {
  createTerminalMouseMode,
  mouseModeAssert,
  mouseModeReporting,
  updateTerminalMouseMode,
} from "@/features/terminal/mounted-terminal/terminalMouseMode";

test("starts from the descriptor and needs both flags", () => {
  expect(mouseModeReporting(createTerminalMouseMode(true))).toBe(true);
  expect(mouseModeReporting(createTerminalMouseMode(false))).toBe(false);
});

test("learns a fullscreen start from the stream, keeping the program's selectors", () => {
  // What `opencode` writes when it starts after the tile already opened on a shell: the
  // descriptor still says false, and this is what flips it before the first wheel or touch.
  const mode = createTerminalMouseMode(false);
  updateTerminalMouseMode(mode, "\u001b[?1049h\u001b[?1002h\u001b[?1006h");
  expect(mouseModeReporting(mode)).toBe(true);
  expect(mouseModeAssert(mode)).toBe("\u001b[?1002h\u001b[?1006h");
});

test("handles one sequence enabling both at once", () => {
  const mode = createTerminalMouseMode(false);
  updateTerminalMouseMode(mode, "\u001b[?1000;1006h");
  expect(mode).toMatchObject({ any: 1000, sgr: 1006 });
});

test("a disable without the encoding stops forwarding but keeps the tracking", () => {
  const mode = createTerminalMouseMode(true);
  updateTerminalMouseMode(mode, "\u001b[?1006l");
  expect(mode).toMatchObject({ any: 1002, sgr: null });
  expect(mouseModeReporting(mode)).toBe(false);
  expect(mouseModeAssert(mode)).toBe("");
});

test("disabling a selector that is not the active one changes nothing", () => {
  const mode = createTerminalMouseMode(false);
  updateTerminalMouseMode(mode, "\u001b[?1002h\u001b[?1006h");
  updateTerminalMouseMode(mode, "\u001b[?1000l");
  expect(mode).toMatchObject({ any: 1002, sgr: 1006 });
});

test("ignores sequences that are not private-mode sets", () => {
  const mode = createTerminalMouseMode(false);
  // Cursor home and show-cursor: no mouse params, so nothing changes.
  updateTerminalMouseMode(mode, "\u001b[H\u001b[?25hplain text");
  expect(mouseModeReporting(mode)).toBe(false);
});

test("matches a sequence split across two writes", () => {
  const mode = createTerminalMouseMode(false);
  updateTerminalMouseMode(mode, "starting up \u001b[?100");
  expect(mouseModeReporting(mode)).toBe(false);
  updateTerminalMouseMode(mode, "2h more \u001b[?10");
  updateTerminalMouseMode(mode, "06h");
  expect(mode).toMatchObject({ any: 1002, sgr: 1006 });
});

test("a full reset clears both flags", () => {
  const mode = createTerminalMouseMode(true);
  updateTerminalMouseMode(mode, "\u001bc");
  expect(mouseModeReporting(mode)).toBe(false);
  expect(mouseModeAssert(mode)).toBe("");
});

test("a descriptor-only true asserts the default pair", () => {
  // tmux says the program wants mouse reports but not which selector: clicks plus wheel,
  // with no hover spam, which 1002 is and 1003 is not.
  expect(mouseModeAssert(createTerminalMouseMode(true))).toBe("\u001b[?1002h\u001b[?1006h");
});
