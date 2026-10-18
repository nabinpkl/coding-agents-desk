// The scroll half of the translator, replayed against the Swift client's own test vectors
// (`client/AgentDeskClientTests/GestureTranslatorTests.swift`). Each case names the Swift test it
// copies; Swift's `processScrollPan(.began/.changed/.ended)` is `begin`/`change`/`end` here.

import { describe, expect, it } from "vitest";
import { scrollAccelerationGain } from "@/features/desktop-viewer/pointer-input/gestureConstants";
import { translatorTestKit } from "@/features/desktop-viewer/pointer-input/translatorTestKit";

const still = { x: 0, y: 0 };

describe("ScrollTranslator, from the Swift vectors", () => {
  it("aFreeAxisDragScrollsBothAxesAtOnce", () => {
    const { translator, outputs } = translatorTestKit();
    translator.scroll.begin(still, "free");
    translator.scroll.change({ x: 10, y: 10 }, { x: 100, y: 100 });
    expect(outputs).toEqual([{ type: "scroll", dx: 10, dy: 10, phase: "began" }]);
  });

  it("theSameDiagonalDragEmitsNothingUnderTheLockedPolicy", () => {
    const { translator, outputs } = translatorTestKit();
    translator.scroll.begin(still);
    translator.scroll.change({ x: 10, y: 10 }, { x: 100, y: 100 });
    expect(outputs).toEqual([]);
  });

  it("theDirectionPreferenceAppliesToBothFreeAxes", () => {
    const first = (naturalScrolling: boolean) => {
      const { translator, outputs } = translatorTestKit({ tuning: { naturalScrolling } });
      translator.scroll.begin(still, "free");
      translator.scroll.change({ x: 10, y: 10 }, { x: 100, y: 100 });
      return outputs[0];
    };
    expect(first(true)).toEqual({ type: "scroll", dx: -10, dy: -10, phase: "began" });
    expect(first(false)).toEqual({ type: "scroll", dx: 10, dy: 10, phase: "began" });
  });

  it("theDirectionPreferenceAppliesToTheLockedHorizontalAxis", () => {
    const first = (naturalScrolling: boolean) => {
      const { translator, outputs } = translatorTestKit({ tuning: { naturalScrolling } });
      translator.scroll.begin(still);
      translator.scroll.change({ x: 13, y: 3 }, { x: 240, y: 10 });
      return outputs[0];
    };
    expect(first(true)).toEqual({ type: "scroll", dx: -13, dy: 0, phase: "began" });
    expect(first(false)).toEqual({ type: "scroll", dx: 13, dy: 0, phase: "began" });
  });

  it("scrollStripLocksVerticalAndEmitsDyDeltasOnly", () => {
    const { translator, outputs } = translatorTestKit();
    translator.scroll.begin(still);
    translator.scroll.change({ x: 3, y: 13 }, { x: 20, y: 200 });
    translator.scroll.change({ x: 5, y: 25 }, { x: 30, y: 220 });
    translator.scroll.end(still, false);
    expect(outputs).toEqual([
      { type: "scroll", dx: 0, dy: 13, phase: "began" },
      { type: "scroll", dx: 0, dy: 12, phase: "changed" },
      { type: "scroll", dx: 0, dy: 0, phase: "ended" },
    ]);
  });

  it("scrollStripLocksHorizontalAndEmitsDxDeltasOnly", () => {
    const { translator, outputs } = translatorTestKit();
    translator.scroll.begin(still);
    translator.scroll.change({ x: 13, y: 3 }, { x: 240, y: 10 });
    translator.scroll.change({ x: 31, y: 8 }, { x: 260, y: 20 });
    translator.scroll.end(still, false);
    expect(outputs).toEqual([
      { type: "scroll", dx: 13, dy: 0, phase: "began" },
      { type: "scroll", dx: 18, dy: 0, phase: "changed" },
      { type: "scroll", dx: 0, dy: 0, phase: "ended" },
    ]);
  });

  it("scrollStripWaitsForDominantAxisBeforeEmitting", () => {
    const { translator, outputs } = translatorTestKit();
    translator.scroll.begin(still);
    translator.scroll.change({ x: 10, y: 10 }, { x: 200, y: 200 });
    translator.scroll.change({ x: 20, y: 12 }, { x: 240, y: 80 });
    expect(outputs).toEqual([{ type: "scroll", dx: 20, dy: 0, phase: "began" }]);
  });

  it("scrollEndedWithoutAnyChangedEmitsNothing", () => {
    const { translator, outputs } = translatorTestKit();
    translator.scroll.begin(still);
    translator.scroll.end(still);
    expect(outputs).toEqual([]);
  });

  it("scrollChangedFirstStillEmitsScroll", () => {
    const { translator, outputs } = translatorTestKit();
    translator.scroll.change({ x: 0, y: 13 }, still);
    translator.scroll.end(still);
    expect(outputs).toEqual([
      { type: "scroll", dx: 0, dy: 13, phase: "began" },
      { type: "scroll", dx: 0, dy: 0, phase: "ended" },
    ]);
  });

  it("horizontalScrollMomentumStaysHorizontal", () => {
    const { translator, outputs, runFrames } = translatorTestKit();
    translator.scroll.begin(still);
    translator.scroll.change({ x: 18, y: 2 }, { x: 500, y: 40 });
    translator.scroll.end({ x: 500, y: 40 });
    runFrames(50);
    const drag = outputs[0];
    const tail = outputs.at(-1);
    expect(tail).toMatchObject({ type: "scroll", phase: "momentumBegan", dy: 0 });
    if (drag?.type !== "scroll" || tail?.type !== "scroll") throw new Error("expected scrolls");
    expect(tail.dx).not.toBe(0);
    expect(Math.sign(tail.dx)).toBe(Math.sign(drag.dx));
  });

  it("scrollTapWithoutMotionEmitsNothing", () => {
    const { translator, outputs } = translatorTestKit();
    translator.scroll.begin(still);
    translator.scroll.end(still);
    expect(outputs).toEqual([]);
  });
});

describe("ScrollTranslator coast", () => {
  it("decays as e^(-2.8 t), steps by v*dt*gain, and ends below 30 pt/s", () => {
    const { translator, outputs, runFrames } = translatorTestKit({ accelerated: true });
    translator.scroll.begin(still, "free");
    translator.scroll.change({ x: 0, y: 20 }, { x: 0, y: 1_000 });
    translator.scroll.end(still);
    runFrames(16);
    const v = 1_000 * Math.exp(-2.8 * 0.016);
    expect(outputs.at(-1)).toEqual({
      type: "scroll",
      dx: 0,
      dy: v * 0.016 * scrollAccelerationGain(v),
      phase: "momentumBegan",
    });
    for (let frame = 2; outputs.at(-1)?.type === "scroll" && translator.scroll.isCoasting; frame += 1) {
      runFrames(frame * 16);
    }
    expect(outputs.at(-1)).toEqual({ type: "scroll", dx: 0, dy: 0, phase: "momentumEnded" });
    const coast = outputs.filter((output) => output.type === "scroll" && output.phase.startsWith("momentum"));
    // About 1.2s of frames from 1000 pt/s down to 30.
    expect(coast.length).toBeGreaterThan(60);
    expect(coast.length).toBeLessThan(90);
  });

  it("does not coast from a slow lift", () => {
    const { translator, pendingFrames } = translatorTestKit();
    translator.scroll.begin(still, "free");
    translator.scroll.change({ x: 0, y: 20 }, { x: 0, y: 150 });
    translator.scroll.end(still);
    expect(pendingFrames()).toBe(0);
  });

  it("seeds the coast from the last velocity seen moving, not the one at lift", () => {
    const { translator, pendingFrames } = translatorTestKit();
    translator.scroll.begin(still, "free");
    translator.scroll.change({ x: 0, y: 20 }, { x: 0, y: 800 });
    translator.scroll.end({ x: 0, y: 0 });
    expect(pendingFrames()).toBe(1);
  });

  it("a new touch ends the coast and says so", () => {
    const { translator, outputs, runFrames } = translatorTestKit();
    translator.scroll.begin(still, "free");
    translator.scroll.change({ x: 0, y: 20 }, { x: 0, y: 800 });
    translator.scroll.end(still);
    runFrames(16);
    translator.scroll.begin(still);
    expect(outputs.at(-1)).toEqual({ type: "scroll", dx: 0, dy: 0, phase: "momentumEnded" });
    expect(translator.scroll.isCoasting).toBe(false);
  });

  it("scales the drag and the coast by scroll speed", () => {
    const { translator, outputs } = translatorTestKit({ tuning: { scrollSpeed: 2 } });
    translator.scroll.begin(still, "free");
    translator.scroll.change({ x: 0, y: 10 }, still);
    expect(outputs[0]).toEqual({ type: "scroll", dx: 0, dy: 20, phase: "began" });
  });
});

describe("ScrollTranslator wheel", () => {
  it("sends the wheel unaccelerated in the finger's phase, and ends it when told", () => {
    const { translator, outputs } = translatorTestKit({ accelerated: true });
    translator.scroll.wheelScroll(0, -30);
    translator.scroll.wheelScroll(0, -30);
    translator.scroll.wheelEnd();
    expect(outputs).toEqual([
      { type: "scroll", dx: 0, dy: -30, phase: "began" },
      { type: "scroll", dx: 0, dy: -30, phase: "changed" },
      { type: "scroll", dx: 0, dy: 0, phase: "ended" },
    ]);
  });
});
