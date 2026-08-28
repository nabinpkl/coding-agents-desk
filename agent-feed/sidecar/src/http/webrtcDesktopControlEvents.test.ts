import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { WebrtcDesktopControlEvents } from "./webrtcDesktopControlEvents.ts";

const encoder = new TextEncoder();
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function event(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function image(png = pngBytes.toString("base64")) {
  return {
    type: "cursor-image",
    png,
    hotspotXFrac: 0.25,
    hotspotYFrac: 0.5,
    widthPoints: 16,
    heightPoints: 24,
    hidden: false,
    cursorKind: "ibeam",
  } as const;
}

describe("WebrtcDesktopControlEvents", () => {
  test("validates and retains only shared cursor state", () => {
    const events = new WebrtcDesktopControlEvents();
    const accepted = events.accept(event(image()));
    if (!accepted || accepted.type !== "cursor-image") throw new Error("cursor image was rejected");
    expect(accepted).toEqual({
      ...image(),
      hash: createHash("sha256").update(pngBytes).digest("hex"),
    });
    expect(events.accept(event(image()))).toBeNull();
    expect(events.accept(event({ type: "cursor-applied", revision: 41, x: 421, y: 181 })))
      .toEqual({ type: "cursor-applied", revision: 41, x: 421, y: 181 });
    expect(events.cursorSnapshot()).toEqual([
      accepted,
      { type: "cursor-position", x: 421, y: 181 },
    ]);
  });

  test("forwards correlated focus and delivery events without retaining them", () => {
    const events = new WebrtcDesktopControlEvents();
    const focus = {
      type: "text-focus",
      focusRequestId: "5f03b272-2922-4ca1-93ee-82d902fdbe21",
      editability: "editable",
      secure: true,
      source: "accessibility",
      role: "AXTextField",
      cursorKind: "ibeam",
    } as const;
    expect(events.accept(event(focus))).toEqual(focus);
    expect(events.accept(event({ type: "input-applied", sequence: 4 })))
      .toEqual({ type: "input-applied", sequence: 4 });
    expect(events.accept(event({
      type: "input-rejected", sequence: 5, reason: "accessibility-denied",
    }))).toEqual({ type: "input-rejected", sequence: 5, reason: "accessibility-denied" });
    expect(events.cursorSnapshot()).toEqual([]);
  });

  test("rejects malformed native events", () => {
    const events = new WebrtcDesktopControlEvents();
    expect(events.accept(event(image(Buffer.from("not-png").toString("base64"))))).toBeNull();
    expect(events.accept(event({ ...image(), cursorKind: "busy-ish" }))).toBeNull();
    expect(events.accept(event({ type: "cursor-applied", revision: 0, x: 1, y: 1 })))
      .toBeNull();
    expect(events.accept(event({ type: "input-applied", sequence: 0 }))).toBeNull();
  });

  test("late join replays only the latest topology, not switch results, and detects unplug", () => {
    const events = new WebrtcDesktopControlEvents();
    const state = { type: "desktop-state" as const, revision: 1, captureDisplayId: "A", displays: [{
      id: "A", label: "Main", isMain: true, activeSpaceId: "1", spaces: [{ id: "1", type: 0 }],
    }] };
    expect(events.accept(event(state))).toEqual(state);
    expect(events.captureDisplayMissing("A")).toBe(false);
    const result = { type: "space-result", requestId: "5f03b272-2922-4ca1-93ee-82d902fdbe21", status: "posted" } as const;
    expect(events.accept(event(result))).toEqual(result);
    expect(events.snapshot()).toEqual([state]);
    const unplugged = { ...state, revision: 2, displays: [] };
    expect(events.accept(event(unplugged))).toEqual(unplugged);
    expect(events.accept(event(state))).toBeNull();
    expect(events.snapshot()).toEqual([unplugged]);
    expect(events.captureDisplayMissing("A")).toBe(true);
    const unavailable = { type: "desktop-unavailable", reason: "navigation-unavailable" } as const;
    events.accept(event(unavailable));
    expect(events.snapshot()).toEqual([unplugged, unavailable]);
  });
});
