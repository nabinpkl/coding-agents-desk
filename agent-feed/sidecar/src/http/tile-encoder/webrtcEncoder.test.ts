// The encoder behind a tile: the control channel it is driven on, the keyframes it is
// asked for against the ones it emits, when a peer is past saving, and which capture
// stream an offer belongs to.

import { describe, expect, test } from "bun:test";
import {
  isTerminalWebrtcConnectionState,
  WebrtcEncoderDiagnostics,
  writeEncoderControl,
  encoderSourceRect,
  encoderDisposition,
  encoderStreamKey,
} from "@/http/tile-peer/webrtcTileRoutes";

describe("WebRTC encoder diagnostics", () => {
  test("flushes each control command instead of waiting for a full pipe buffer", () => {
    const calls: string[] = [];
    const accepted = writeEncoderControl({
      write: (line) => calls.push(`write:${line}`),
      flush: () => {
        calls.push("flush");
        return 2;
      },
    }, "K\n", (error) => calls.push(`error:${String(error)}`));

    expect(accepted).toBe(true);
    expect(calls).toEqual(["write:K\n", "flush"]);
  });

  test("separates repeated PLI requests from emitted keyframes", () => {
    const lines: string[] = [];
    const stats = new WebrtcEncoderDiagnostics("display", (line) => lines.push(line), 1_000);

    stats.recordAccessUnit(1_000, true, 1_100);
    stats.recordAccessUnit(100, false, 1_200);
    stats.recordKeyframeRequest("pli");
    stats.recordKeyframeRequest("pli");
    stats.recordKeyframeRequest("pli");
    stats.recordAccessUnit(800, true, 1_500);
    stats.flush(11_000);

    expect(lines[0]).toContain("requestContext=startup");
    expect(lines[1]).toContain("requestContext=pending-pli");
    expect(lines[1]).toContain("pendingPli=3");
    expect(lines[1]).toContain("intervalMs=400");
    expect(lines[1]).toContain("accessUnitsSincePrevious=2");
    expect(lines[2]).toContain("accessUnits=3 keyframes=2 deltas=1");
    expect(lines[2]).toContain("keyframeBytes=1800 keyframeBytePct=94.7 pliRequests=3");
    expect(lines[2]).toContain("totalAccessUnits=3 totalKeyframes=2");
  });
});

describe("WebRTC connection lifecycle", () => {
  test("keeps transient disconnects alive and closes terminal peers", () => {
    expect(isTerminalWebrtcConnectionState("connected")).toBe(false);
    expect(isTerminalWebrtcConnectionState("disconnected")).toBe(false);
    expect(isTerminalWebrtcConnectionState("failed")).toBe(true);
    expect(isTerminalWebrtcConnectionState("closed")).toBe(true);
  });
});

describe("encoderSourceRect", () => {
  test("formats a usable crop the way the helper parses it", () => {
    expect(encoderSourceRect({ x: 2400, y: 1200, width: 1920, height: 1080 }))
      .toBe("2400,1200,1920,1080");
  });

  test("rounds, because the viewport's arithmetic is fractional and display points are not", () => {
    expect(encoderSourceRect({ x: 100.4, y: 200.6, width: 640.5, height: 480.2 }))
      .toBe("100,201,641,480");
  });

  test("drops the whole crop when any part of it is unusable", () => {
    // A half-applied crop is a stream pointed confidently at the wrong part of the desktop.
    expect(encoderSourceRect({ x: 0, y: 0, width: 1920 })).toBeUndefined();
    expect(encoderSourceRect({ x: -1, y: 0, width: 1920, height: 1080 })).toBeUndefined();
    expect(encoderSourceRect({ x: 0, y: 0, width: 8, height: 1080 })).toBeUndefined();
    expect(encoderSourceRect({ x: 0, y: 0, width: 1920, height: 99999 })).toBeUndefined();
    expect(encoderSourceRect({ x: 0, y: 0, width: Number.NaN, height: 1080 })).toBeUndefined();
  });

  test("treats a missing or non-object crop as no crop at all", () => {
    expect(encoderSourceRect(undefined)).toBeUndefined();
    expect(encoderSourceRect(null)).toBeUndefined();
    expect(encoderSourceRect("2400,1200,1920,1080")).toBeUndefined();
  });
});

describe("one encoder per capture stream", () => {
  const wanted = { identity: "--display 224 --width 5776" };
  const running = (overrides: Partial<{ identity: string; subscribers: number }> = {}) => ({
    identity: wanted.identity,
    subscribers: 1,
    ...overrides,
  });

  test("nothing running means the offer starts the capture", () => {
    expect(encoderDisposition(undefined, wanted)).toBe("spawn");
  });

  test("an identical offer joins the running capture rather than starting a second", () => {
    expect(encoderDisposition(running(), wanted)).toBe("reuse");
  });

  test("a watched stream is joined at its own resolution, never doubled", () => {
    // The measured failure: 990 wide beside 5776 wide on one display for 557 seconds, both
    // starving. Evicting the watcher instead would have it reconnect and evict this one back.
    expect(encoderDisposition(running({ identity: "--display 224 --width 990" }), wanted)).toBe("join");
  });

  test("an unwatched stream is retasked, so the resolution knob still moves", () => {
    expect(encoderDisposition(running({ identity: "--display 224 --width 990", subscribers: 0 }), wanted))
      .toBe("retask");
  });
});

describe("what counts as a separate capture stream", () => {
  const args = (...rest: string[]) => ["--display", "224", "--codec", "h265-annexb", ...rest];

  test("a crop is its own stream, because the overview and the detail are different pixels", () => {
    expect(encoderStreamKey("display:A", args("--source-rect", "0,0,800,600")))
      .not.toBe(encoderStreamKey("display:A", args()));
    expect(encoderStreamKey("display:A", args("--source-rect", "0,0,800,600")))
      .not.toBe(encoderStreamKey("display:A", args("--source-rect", "10,0,800,600")));
  });

  test("a resolution is not, because that is the same pixels twice", () => {
    expect(encoderStreamKey("display:A", args("--width", "5776", "--fps", "15")))
      .toBe(encoderStreamKey("display:A", args("--width", "990", "--fps", "8")));
  });

  test("targets never share a stream, whatever they ask for", () => {
    expect(encoderStreamKey("display:A", args())).not.toBe(encoderStreamKey("display:B", args()));
  });
});

