import { describe, expect, test } from "bun:test";
import type { DesktopControlInput } from "@agentdesk/agent-feed-wire";
import fixture from "../../../wire/contract-fixture.json";
import {
  desktopControlInput,
  desktopControlLine,
  desktopControlRejectionReason,
  MAX_DESKTOP_CONTROL_MESSAGE_BYTES,
  MAX_DESKTOP_KEY_BATCH,
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
});
