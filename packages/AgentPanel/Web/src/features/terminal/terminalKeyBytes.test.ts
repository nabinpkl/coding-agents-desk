import { describe, expect, it } from "vitest";
import {
  applyModifiers,
  bytesForRailKey,
  controlByte,
  modifierParameter,
  NO_MODIFIERS,
  type RailModifiers,
} from "./terminalKeyBytes";

const held = (overrides: Partial<RailModifiers>): RailModifiers => ({
  ...NO_MODIFIERS,
  ...overrides,
});

describe("rail keys", () => {
  it("sends the bare sequences when nothing is held", () => {
    expect(bytesForRailKey("escape")).toBe("\u001b");
    expect(bytesForRailKey("tab")).toBe("\t");
    expect(bytesForRailKey("up")).toBe("\u001b[A");
    expect(bytesForRailKey("down")).toBe("\u001b[B");
    expect(bytesForRailKey("right")).toBe("\u001b[C");
    expect(bytesForRailKey("left")).toBe("\u001b[D");
  });

  it("spells a modified arrow with the parameter form, which is a different sequence", () => {
    // A program that only matches the bare form must not see a modified arrow as a plain one, so
    // the parameter is added rather than the modifier being dropped.
    expect(bytesForRailKey("up", held({ shift: true }))).toBe("\u001b[1;2A");
    expect(bytesForRailKey("left", held({ alt: true }))).toBe("\u001b[1;3D");
    expect(bytesForRailKey("right", held({ ctrl: true }))).toBe("\u001b[1;5C");
    expect(bytesForRailKey("down", held({ ctrl: true, shift: true }))).toBe("\u001b[1;6B");
  });

  it("gives Shift-Tab its own sequence rather than a modified Tab", () => {
    expect(bytesForRailKey("tab", held({ shift: true }))).toBe("\u001b[Z");
  });

  it("counts modifiers from one, so nothing held is 1", () => {
    expect(modifierParameter(NO_MODIFIERS)).toBe(1);
    expect(modifierParameter(held({ ctrl: true, alt: true, shift: true }))).toBe(8);
  });
});

describe("control bytes", () => {
  it("folds a letter onto its control code whatever its case", () => {
    expect(controlByte("c")).toBe("\u0003");
    expect(controlByte("C")).toBe("\u0003");
    expect(controlByte("d")).toBe("\u0004");
    // tmux's own prefix, which is the reason a rail Ctrl exists at all on a phone.
    expect(controlByte("b")).toBe("\u0002");
  });

  it("covers the two the arithmetic does not", () => {
    expect(controlByte(" ")).toBe("\u0000");
    expect(controlByte("?")).toBe("\u007f");
  });

  it("returns null where there is no control byte to send", () => {
    expect(controlByte("é")).toBeNull();
    expect(controlByte("hello")).toBeNull();
  });
});

describe("held modifiers over typed text", () => {
  it("passes text through untouched when nothing is held", () => {
    expect(applyModifiers("a", NO_MODIFIERS)).toBe("a");
  });

  it("applies Ctrl to the character the keyboard produced", () => {
    expect(applyModifiers("c", held({ ctrl: true }))).toBe("\u0003");
  });

  it("spells Alt as an escape prefix, which is what Meta has always been", () => {
    expect(applyModifiers("f", held({ alt: true }))).toBe("\u001bf");
    expect(applyModifiers("a", held({ alt: true, ctrl: true }))).toBe("\u001b\u0001");
  });

  it("leaves alone what a modifier cannot be applied to", () => {
    // A paste or an IME commit arrives as one `onData` too. Mangling it into a control byte would
    // lose the text; sending it as typed is at worst an unmodified paste.
    expect(applyModifiers("pasted text", held({ ctrl: true }))).toBe("pasted text");
  });

  it("leaves Shift to the keys the rail sends itself", () => {
    // The phone's keyboard already sent the capital; upcasing it here would be the second one.
    expect(applyModifiers("a", held({ shift: true }))).toBe("a");
  });
});
