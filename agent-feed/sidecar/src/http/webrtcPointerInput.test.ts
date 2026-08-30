import { describe, expect, test } from "bun:test";
import { encoderPointerCommand } from "./webrtcPointerInput.ts";

describe("WebRTC pointer input", () => {
  test("translates the bounded pointer-mode contract to native stdin commands", () => {
    expect(encoderPointerCommand('{"t":"move","dx":12.5,"dy":-3}')).toBe("M 12.5 -3\n");
    expect(encoderPointerCommand('{"t":"click","button":"left"}')).toBe("C L\n");
    expect(encoderPointerCommand('{"t":"click","button":"right"}')).toBe("C R\n");
    expect(encoderPointerCommand('{"t":"scroll","dx":2,"dy":-8,"phase":"changed"}'))
      .toBe("S 2 -8 c\n");
  });

  test("rejects malformed, oversized, non-finite, and unknown commands", () => {
    expect(encoderPointerCommand("not-json")).toBeNull();
    expect(encoderPointerCommand(JSON.stringify({ t: "move", dx: 10_001, dy: 0 }))).toBeNull();
    expect(encoderPointerCommand(JSON.stringify({ t: "move", dx: null, dy: 0 }))).toBeNull();
    expect(encoderPointerCommand(JSON.stringify({ t: "scroll", dx: 0, dy: 1, phase: "future" })))
      .toBeNull();
    expect(encoderPointerCommand(JSON.stringify({ t: "future" }))).toBeNull();
    expect(encoderPointerCommand(Buffer.alloc(257, 0x20))).toBeNull();
  });
});
