import { describe, expect, it } from "vitest";
import { DOUBLE_SHIFT_MS, doubleShiftDetector } from "@/features/workspace-ide/search/useSearchShortcuts";
import { parseQuickOpenQuery } from "@/features/workspace-ide/search/QuickOpen";

const key = (name: string, timeStamp: number, extra: Partial<KeyboardEvent> = {}) =>
  ({ key: name, timeStamp, repeat: false, metaKey: false, ctrlKey: false, altKey: false, ...extra });

describe("doubleShiftDetector", () => {
  it("fires on two bare Shift presses in quick succession, once", () => {
    const detect = doubleShiftDetector();
    expect(detect(key("Shift", 0))).toBe(false);
    expect(detect(key("Shift", 200))).toBe(true);
    // A third press starts a new pair rather than firing again.
    expect(detect(key("Shift", 300))).toBe(false);
  });

  it("does not fire when the presses are too far apart", () => {
    const detect = doubleShiftDetector();
    detect(key("Shift", 0));
    expect(detect(key("Shift", DOUBLE_SHIFT_MS + 1))).toBe(false);
  });

  it("does not fire across typing: Shift, a letter, Shift is capitals, not a shortcut", () => {
    const detect = doubleShiftDetector();
    detect(key("Shift", 0));
    detect(key("A", 50, { shiftKey: true } as Partial<KeyboardEvent>));
    expect(detect(key("Shift", 100))).toBe(false);
  });

  it("does not fire on a held Shift's repeats or with another modifier down", () => {
    const detect = doubleShiftDetector();
    detect(key("Shift", 0));
    expect(detect(key("Shift", 30, { repeat: true }))).toBe(false);
    const other = doubleShiftDetector();
    other(key("Shift", 0));
    expect(other(key("Shift", 100, { metaKey: true }))).toBe(false);
  });
});

describe("parseQuickOpenQuery", () => {
  it("reads a trailing line number, and ignores a colon still being typed", () => {
    expect(parseQuickOpenQuery("src/app.ts:42")).toEqual({ query: "src/app.ts", line: 42 });
    expect(parseQuickOpenQuery("app:")).toEqual({ query: "app", line: null });
    expect(parseQuickOpenQuery(" app ")).toEqual({ query: "app", line: null });
  });
});
