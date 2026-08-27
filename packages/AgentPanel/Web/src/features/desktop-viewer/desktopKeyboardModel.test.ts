import { describe, expect, test } from "vitest";
import type { DesktopTextFocusEvent } from "@agentdesk/agent-feed-wire";
import {
  activeModifiers,
  clearArmedModifiers,
  cycleModifier,
  INITIAL_KEYBOARD_PRESENTATION,
  keyboardPresentationReducer,
  receiptToken,
  remoteKeysForText,
} from "./desktopKeyboardModel";

const requestA = "5f03b272-2922-4ca1-93ee-82d902fdbe21";
const requestB = "f7d14184-bfc7-4510-9e33-6f74bd611c25";

function focus(
  focusRequestId: string,
  editability: DesktopTextFocusEvent["editability"],
  cursorKind: DesktopTextFocusEvent["cursorKind"] = "ibeam",
): DesktopTextFocusEvent {
  return {
    type: "text-focus", focusRequestId, editability, cursorKind,
    secure: false, source: "accessibility",
  };
}

describe("desktop keyboard model", () => {
  test("suppresses stale focus and replaces pending taps", () => {
    let state = keyboardPresentationReducer(INITIAL_KEYBOARD_PRESENTATION, { type: "transport-open" });
    state = keyboardPresentationReducer(state, { type: "remote-tap", focusRequestId: requestA });
    state = keyboardPresentationReducer(state, { type: "remote-tap", focusRequestId: requestB });
    expect(keyboardPresentationReducer(state, { type: "focus-result", event: focus(requestA, "editable") }))
      .toBe(state);
    expect(keyboardPresentationReducer(state, { type: "focus-result", event: focus(requestB, "editable") }))
      .toMatchObject({ presentation: "shown", focusRequestId: requestB });
  });

  test("requires I-beam for ambiguous focus and times out only the current request", () => {
    const hidden = keyboardPresentationReducer(INITIAL_KEYBOARD_PRESENTATION, { type: "transport-open" });
    const pending = keyboardPresentationReducer(hidden, { type: "remote-tap", focusRequestId: requestA });
    expect(keyboardPresentationReducer(pending, {
      type: "focus-result", event: focus(requestA, "ambiguous", "arrow"),
    }).presentation).toBe("hidden");
    expect(keyboardPresentationReducer(pending, {
      type: "focus-timeout", focusRequestId: requestB,
    })).toBe(pending);
    expect(keyboardPresentationReducer(pending, {
      type: "focus-timeout", focusRequestId: requestA,
    }).presentation).toBe("hidden");
  });

  test("encodes US ANSI atomically", () => {
    expect(remoteKeysForText("Hi, you!\n")).toEqual([
      { code: "ansi-H", modifiers: ["shift"] },
      { code: "ansi-I", modifiers: [] },
      { code: "ansi-comma", modifiers: [] },
      { code: "space", modifiers: [] },
      { code: "ansi-Y", modifiers: [] },
      { code: "ansi-O", modifiers: [] },
      { code: "ansi-U", modifiers: [] },
      { code: "ansi-1", modifiers: ["shift"] },
      { code: "return", modifiers: [] },
    ]);
    expect(remoteKeysForText("ok😀no")).toBeNull();
  });

  test("cycles sticky modifiers and clears only armed state", () => {
    expect(cycleModifier("off")).toBe("armed");
    expect(cycleModifier("armed")).toBe("locked");
    expect(cycleModifier("locked")).toBe("off");
    const states = { cmd: "armed", ctrl: "off", option: "locked", shift: "off" } as const;
    expect(activeModifiers(states, ["shift"])).toEqual(["cmd", "option", "shift"]);
    expect(clearArmedModifiers(states)).toEqual({
      cmd: "off", ctrl: "off", option: "locked", shift: "off",
    });
  });

  test("secure receipts never recover printable characters", () => {
    const key = remoteKeysForText("A")![0]!;
    expect(receiptToken(key, false)).toBe("A");
    expect(receiptToken(key, true)).toBe("•");
    expect(receiptToken({ code: "space", modifiers: [] }, true)).toBe("•");
    expect(receiptToken({ code: "delete", modifiers: [] }, true)).toBe("⌫");
  });
});
