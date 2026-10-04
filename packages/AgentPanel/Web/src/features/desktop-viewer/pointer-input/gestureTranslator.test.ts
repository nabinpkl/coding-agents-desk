// The pointer half of the translator, replayed against the Swift client's own test vectors
// (`client/AgentDeskClientTests/GestureTranslatorTests.swift`). Each case names the Swift test it
// copies. Swift's `processPan` took the recognizer's cumulative translation; here the same travel
// arrives as positions from touch-down, one display frame each.

import { describe, expect, it } from "vitest";
import { translatorTestKit } from "@/features/desktop-viewer/pointer-input/translatorTestKit";

describe("GestureTranslator pointer, from the Swift vectors", () => {
  it("panEmitsCursorMoveDeltasSinceLastChangedCallback", () => {
    const { translator, outputs, runFrames } = translatorTestKit();
    translator.cursorBegin({ x: 0, y: 0 }, 0);
    translator.cursorSamples([{ x: 5, y: 7 }]);
    runFrames(16);
    translator.cursorSamples([{ x: 12, y: 4 }]);
    runFrames(32);
    translator.cursorSamples([{ x: 12, y: 4 }]);
    runFrames(48);
    translator.cursorEnd(64);
    expect(outputs).toEqual([
      { type: "cursor-move", dx: 5, dy: 7 },
      { type: "cursor-move", dx: 7, dy: -3 },
    ]);
  });

  it("panWithNoMovementBetweenChangedCallbacksEmitsNothing", () => {
    const { translator, outputs, runFrames } = translatorTestKit();
    translator.cursorBegin({ x: 10, y: 10 }, 0);
    translator.cursorSamples([{ x: 10, y: 10 }]);
    runFrames(16);
    expect(outputs).toEqual([]);
  });

  it("newGestureAfterEndStartsDeltaFromBeganTranslation", () => {
    const { translator, outputs, runFrames } = translatorTestKit();
    translator.cursorBegin({ x: 0, y: 0 }, 0);
    translator.cursorSamples([{ x: 20, y: 0 }]);
    translator.cursorEnd(16);
    translator.cursorBegin({ x: 100, y: 100 }, 100);
    translator.cursorSamples([{ x: 105, y: 100 }]);
    runFrames(116);
    expect(outputs).toEqual([
      { type: "cursor-move", dx: 20, dy: 0 },
      { type: "cursor-move", dx: 5, dy: 0 },
    ]);
  });

  it("tapEndedEmitsLeftClick", () => {
    const { translator, outputs } = translatorTestKit();
    translator.tap();
    expect(outputs).toEqual([{ type: "click", button: "left" }]);
  });

  it("dragBeganEmitsDragStart", () => {
    const { translator, outputs } = translatorTestKit();
    translator.dragBegin({ x: 50, y: 50 });
    expect(outputs).toEqual([{ type: "mouse-down", button: "left" }]);
  });

  it("dragChangedEmitsCursorMoveDeltasSinceLastPoint", () => {
    const { translator, outputs } = translatorTestKit();
    translator.dragBegin({ x: 50, y: 50 });
    translator.dragMove({ x: 60, y: 70 }, { width: 0, height: 0 });
    translator.dragMove({ x: 75, y: 70 }, { width: 0, height: 0 });
    expect(outputs).toEqual([
      { type: "mouse-down", button: "left" },
      { type: "cursor-move", dx: 10, dy: 20 },
      { type: "cursor-move", dx: 15, dy: 0 },
    ]);
  });

  it("dragEdgePanContinuesMotionAfterFingerStopsAtScreenEdge", () => {
    const { translator, outputs } = translatorTestKit();
    const bounds = { width: 200, height: 200 };
    translator.dragBegin({ x: 100, y: 100 }, 0);
    translator.dragMove({ x: 148, y: 100 }, bounds, 200);
    translator.dragMove({ x: 198, y: 100 }, bounds, 300);
    translator.dragEdgeTick(400);
    translator.dragEdgeTick(500);
    translator.dragEnd();
    expect(outputs).toEqual([
      { type: "mouse-down", button: "left" },
      { type: "cursor-move", dx: 48, dy: 0 },
      { type: "cursor-move", dx: 50, dy: 0 },
      { type: "cursor-move", dx: 50, dy: 0 },
      { type: "cursor-move", dx: 50, dy: 0 },
      { type: "mouse-up", button: "left" },
    ]);
  });

  it("dragEndedEmitsDragEndAndAllowsPanAgain", () => {
    const { translator, outputs, runFrames } = translatorTestKit();
    translator.dragBegin({ x: 0, y: 0 });
    expect(translator.dragEnd()).toBe(true);
    translator.cursorBegin({ x: 0, y: 0 }, 0);
    translator.cursorSamples([{ x: 5, y: 5 }]);
    runFrames(16);
    expect(outputs).toEqual([
      { type: "mouse-down", button: "left" },
      { type: "mouse-up", button: "left" },
      { type: "cursor-move", dx: 5, dy: 5 },
    ]);
  });

  it("panIsSuppressedDuringDrag", () => {
    const { translator, outputs, runFrames } = translatorTestKit();
    translator.dragBegin({ x: 0, y: 0 });
    translator.cursorBegin({ x: 0, y: 0 }, 0);
    translator.cursorSamples([{ x: 30, y: 30 }]);
    runFrames(16);
    translator.dragEnd();
    expect(outputs).toEqual([
      { type: "mouse-down", button: "left" },
      { type: "mouse-up", button: "left" },
    ]);
  });
});

describe("GestureTranslator pointer, what the browser adds", () => {
  it("drops the travel inside the slop, measured from touch-down", () => {
    const { translator, outputs, runFrames } = translatorTestKit();
    translator.cursorBegin({ x: 0, y: 0 }, 0);
    // 2px is inside the 3px slop and is not sent; the step that crosses it is.
    expect(translator.cursorSamples([{ x: 2, y: 0 }])).toBe(false);
    expect(translator.cursorSamples([{ x: 6, y: 0 }])).toBe(true);
    runFrames(16);
    expect(outputs).toEqual([{ type: "cursor-move", dx: 4, dy: 0 }]);
  });

  it("sums a frame's samples and accelerates by that frame's speed", () => {
    const { translator, outputs, runFrames } = translatorTestKit({ accelerated: true });
    translator.cursorBegin({ x: 0, y: 0 }, 0);
    translator.cursorSamples([{ x: 3, y: 0 }, { x: 6, y: 0 }, { x: 10, y: 0 }]);
    runFrames(20);
    // 10px in 20ms is 500 pt/s: gain 1.5 + 2.5 = 4.
    expect(outputs).toEqual([{ type: "cursor-move", dx: 40, dy: 0 }]);
  });

  it("sends the travel still waiting for a frame when the finger lifts", () => {
    const { translator, outputs, pendingFrames } = translatorTestKit();
    translator.cursorBegin({ x: 0, y: 0 }, 0);
    translator.cursorSamples([{ x: 9, y: 0 }]);
    translator.cursorEnd(10);
    expect(outputs).toEqual([{ type: "cursor-move", dx: 9, dy: 0 }]);
    expect(pendingFrames()).toBe(0);
  });

  it("drags 1:1 whatever the speed, scaled only by the tuning", () => {
    const { translator, outputs } = translatorTestKit({
      accelerated: true,
      tuning: { cursorSpeed: 2, cursorAcceleration: 1.5 },
    });
    translator.dragBegin({ x: 0, y: 0 }, 0);
    translator.dragMove({ x: 100, y: 0 }, { width: 0, height: 0 }, 10);
    expect(outputs.at(-1)).toEqual({ type: "cursor-move", dx: 300, dy: 0 });
  });

  it("stops the edge auto-pan when the finger turns back inward", () => {
    const { translator, outputs } = translatorTestKit();
    const bounds = { width: 200, height: 200 };
    translator.dragBegin({ x: 150, y: 100 }, 0);
    translator.dragMove({ x: 190, y: 100 }, bounds, 100);
    translator.dragMove({ x: 185, y: 100 }, bounds, 200);
    const before = outputs.length;
    translator.dragEdgeTick(300);
    expect(outputs.length).toBe(before);
  });

  it("holds nothing when the press is refused", () => {
    const { translator } = translatorTestKit({ refuse: (output) => output.type === "mouse-down" });
    expect(translator.dragBegin({ x: 0, y: 0 })).toBe(false);
    expect(translator.isDragging).toBe(false);
    expect(translator.dragEnd()).toBe(false);
    expect(translator.accepted).toBe(false);
  });

  it("lets go of a held button and closes a scroll when disposed", () => {
    const { translator, outputs } = translatorTestKit();
    translator.dragBegin({ x: 0, y: 0 });
    translator.scroll.wheelScroll(0, 10);
    translator.dispose();
    expect(outputs.slice(-2)).toEqual([
      { type: "scroll", dx: 0, dy: 0, phase: "ended" },
      { type: "mouse-up", button: "left" },
    ]);
  });
});
