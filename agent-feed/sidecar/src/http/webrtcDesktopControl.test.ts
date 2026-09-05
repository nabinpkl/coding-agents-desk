import { describe, expect, test } from "bun:test";
import type { DesktopControlInput } from "@agentdesk/agent-feed-wire";
import fixture from "../../../wire/contract-fixture.json";
import {
  desktopControlInput,
  desktopControlLine,
  desktopControlRejectionReason,
  MAX_DESKTOP_CONTROL_MESSAGE_BYTES,
  MAX_DESKTOP_KEY_BATCH,
  MAX_DESKTOP_TEXT_UNITS,
} from "./webrtcDesktopControl.ts";

describe("desktop control v2 input", () => {
  test("validates every command and preserves canonical NDJSON", () => {
    const commands = fixture.desktopControlV2.validInputs as DesktopControlInput[];
    for (const command of commands) {
      const validated = desktopControlInput(JSON.stringify(command));
      expect(validated).toEqual(command);
      expect(desktopControlLine(validated!)).toBe(`${JSON.stringify(command)}\n`);
    }
  });

  test("bounds batches, sequences, deltas, focus IDs, and total bytes", () => {
    const key = { code: "ansi-A", modifiers: [] };
    expect(desktopControlInput("not-json")).toBeNull();
    expect(desktopControlInput(JSON.stringify({
      type: "pointer-move", revision: 0, dx: 1, dy: 0,
    }))).toBeNull();
    expect(desktopControlInput(JSON.stringify({
      type: "pointer-move", revision: 1, dx: 10_001, dy: 0,
    }))).toBeNull();
    expect(desktopControlInput(JSON.stringify({
      type: "click", button: "left", focusRequestId: "not-a-uuid",
    }))).toBeNull();
    expect(desktopControlInput(JSON.stringify({
      type: "key-batch", sequence: 1, keys: Array(MAX_DESKTOP_KEY_BATCH + 1).fill(key),
    }))).toBeNull();
    expect(desktopControlInput(JSON.stringify({
      type: "key-batch", sequence: 1, keys: [{ code: "future-key", modifiers: [] }],
    }))).toBeNull();
    expect(desktopControlInput(Buffer.alloc(MAX_DESKTOP_CONTROL_MESSAGE_BYTES + 1, 0x20)))
      .toBeNull();
    expect(desktopControlRejectionReason(
      Buffer.alloc(MAX_DESKTOP_CONTROL_MESSAGE_BYTES + 1, 0x20),
    )).toBe("oversized");
    expect(desktopControlRejectionReason(JSON.stringify({
      type: "key-batch", sequence: 1, keys: Array(MAX_DESKTOP_KEY_BATCH + 1).fill(key),
    }))).toBe("oversized");
  });

  test("passes text through by length alone, since the helper types whatever it is given", () => {
    // No character vocabulary is enforced here on purpose: the point of this input is to carry
    // what a key code cannot, so an em dash and an emoji have to survive validation unchanged.
    expect(desktopControlInput(JSON.stringify({
      type: "text", sequence: 4, text: "caf\u00e9 \u2014 \ud83d\udc4b",
    }))).toEqual({ type: "text", sequence: 4, text: "caf\u00e9 \u2014 \ud83d\udc4b" });
    expect(desktopControlInput(JSON.stringify({ type: "text", sequence: 4, text: "" }))).toBeNull();
    expect(desktopControlInput(JSON.stringify({ type: "text", sequence: 0, text: "hi" }))).toBeNull();
    expect(desktopControlInput(JSON.stringify({ type: "text", sequence: 4, text: 12 }))).toBeNull();
    const tooLong = "a".repeat(MAX_DESKTOP_TEXT_UNITS + 1);
    expect(desktopControlInput(JSON.stringify({ type: "text", sequence: 4, text: tooLong }))).toBeNull();
    expect(desktopControlRejectionReason(JSON.stringify({
      type: "text", sequence: 4, text: tooLong,
    }))).toBe("oversized");
  });
});
