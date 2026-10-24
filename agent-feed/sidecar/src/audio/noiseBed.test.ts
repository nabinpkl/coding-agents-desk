import { describe, expect, test } from "bun:test";
import { AUDIO_NOISE_COLORS } from "@agentdesk/agent-feed-wire";
import type { AdtsFrame } from "@/audio/adtsFrames";
import { FRAME_SAMPLES, makeNoiseBed, spliceMessage, type NoiseBed } from "@/audio/noiseBed";
import { noiseLoopSamples } from "@/audio/noiseColors";

/**
 * An encoder with a delay, as a real one has, whose frame `k` carries the one input sample it would
 * have started decoding at, `k * 1024 - delay`, so a test can read back what each frame holds.
 */
function delayingEncoder(delay: number) {
  return (samples: Int16Array): Promise<AdtsFrame[]> => {
    const count = Math.ceil((samples.length + delay) / FRAME_SAMPLES) + 1;
    return Promise.resolve(
      Array.from({ length: count }, (_, k) => {
        const at = k * FRAME_SAMPLES - delay;
        const value = at >= 0 && at < samples.length ? (samples[at] ?? 0) : -1;
        return { bytes: new Uint8Array(new Int16Array([value]).buffer), durationMs: 46.4 };
      }),
    );
  };
}

const held = (frame: AdtsFrame | undefined) => (frame ? new Int16Array(frame.bytes.buffer)[0] : undefined);

/** A bed whose samples count up, so each frame says where in the loop it is. */
async function countingBed(loopFrames: number, delay: number): Promise<NoiseBed> {
  const samples = Int16Array.from({ length: loopFrames * FRAME_SAMPLES }, (_, index) => index % 30_000);
  const encode = delayingEncoder(delay);
  const tiled = new Int16Array(samples.length * 3);
  for (let copy = 0; copy < 3; copy += 1) tiled.set(samples, copy * samples.length);
  return { samples, frames: (await encode(tiled)).slice(loopFrames, 2 * loopFrames) };
}

describe("the noise bed", () => {
  test("a loop's frames run on from its last into its first, as the frames inside it do", async () => {
    const bed = await countingBed(10, 2112);
    const positions = bed.frames.map(held);
    const loopLength = 10 * FRAME_SAMPLES;
    positions.forEach((position, index) => {
      expect(position).toBe(((((index * FRAME_SAMPLES - 2112) % loopLength) + loopLength) % loopLength) % 30_000);
    });
  });

  for (const delay of [0, 2112, 3000]) {
    test(`a message decodes to the very stretch of the loop it replaces, with an encoder delay of ${delay}`, async () => {
      const bed = await countingBed(10, delay);
      const atFrame = 27; // past the end of the loop twice, so it wraps
      const frames = await spliceMessage(bed, atFrame, new Int16Array(3 * FRAME_SAMPLES), delayingEncoder(delay));
      frames.forEach((frame, index) => expect(held(frame)).toBe(held(bed.frames[(atFrame + index) % 10])));
    });
  }

  test("a message keeps frames enough to hold every sample of the voice", async () => {
    const bed = await countingBed(10, 2112);
    const voice = new Int16Array(5 * FRAME_SAMPLES + 300).fill(5);
    const frames = await spliceMessage(bed, 4, voice, delayingEncoder(2112));
    const voiced = frames.filter((frame, index) => held(frame) === (held(bed.frames[(4 + index) % 10]) ?? 0) + 5);
    expect(voiced.length).toBeGreaterThanOrEqual(5);
    expect(held(frames.at(-1))).toBe(held(bed.frames[(4 + frames.length - 1) % 10]));
  });

  test("a message's voice is scaled by its gain, over noise that is not", async () => {
    const bed = await countingBed(10, 2112);
    const voice = new Int16Array(4 * FRAME_SAMPLES).fill(100);
    const full = await spliceMessage(bed, 4, voice, delayingEncoder(2112), 1);
    const half = await spliceMessage(bed, 4, voice, delayingEncoder(2112), 0.5);
    const lift = (frames: AdtsFrame[]) =>
      frames.map((frame, index) => (held(frame) ?? 0) - (held(bed.frames[(4 + index) % 10]) ?? 0));
    expect(Math.max(...lift(full))).toBe(100);
    expect(Math.max(...lift(half))).toBe(50);
    expect(Math.min(...lift(half))).toBe(0);
  });

  test("makes a loop from three copies and keeps the middle one", async () => {
    let encoded = 0;
    const bed = await makeNoiseBed(
      "pink",
      3,
      (samples) => {
        encoded = samples.length;
        return delayingEncoder(2112)(samples);
      },
      10,
    );
    expect(encoded).toBe(3 * 10 * FRAME_SAMPLES);
    expect(bed.frames.length).toBe(10);
  });
});

describe("noise colors", () => {
  const rms = (samples: Int16Array) =>
    Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);

  test("every color is equally loud at a level, and level 0 is silence", () => {
    const loudness = AUDIO_NOISE_COLORS.map((color) => rms(noiseLoopSamples(color, 5, 4 * 22_050)));
    for (const each of loudness) expect(each).toBeCloseTo(loudness[0] ?? 0, -1);
    expect(rms(noiseLoopSamples("brown", 0, 22_050))).toBe(0);
  });

  test("a loop's last sample runs into its first like any neighbors do, so it repeats without a click", () => {
    for (const color of AUDIO_NOISE_COLORS) {
      const loop = noiseLoopSamples(color, 8, 4 * 22_050);
      const steps = loop.slice(1).map((value, index) => Math.abs(value - (loop[index] ?? 0)));
      const largest = Math.max(...steps);
      expect(Math.abs((loop[0] ?? 0) - (loop.at(-1) ?? 0))).toBeLessThanOrEqual(largest);
    }
  });

  test("brown is weighted to the low end and white is not: neighbors differ far less", () => {
    const meanStep = (samples: Int16Array) =>
      samples.slice(1).reduce((sum, value, index) => sum + Math.abs(value - (samples[index] ?? 0)), 0) / samples.length;
    const white = meanStep(noiseLoopSamples("white", 5, 22_050));
    const pink = meanStep(noiseLoopSamples("pink", 5, 22_050));
    const brown = meanStep(noiseLoopSamples("brown", 5, 22_050));
    expect(pink).toBeLessThan(white);
    expect(brown).toBeLessThan(pink / 2);
  });
});
