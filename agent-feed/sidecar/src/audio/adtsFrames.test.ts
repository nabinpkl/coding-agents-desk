import { describe, expect, test } from "bun:test";
import { splitAdtsFrames } from "@/audio/adtsFrames";

/** One ADTS frame: MPEG-4 AAC LC, mono, the given sampling-frequency index, `payload` bytes after the header. */
function frame(payload: number, frequencyIndex = 7): number[] {
  const length = 7 + payload;
  return [
    0xff,
    0xf1,
    (1 << 6) | (frequencyIndex << 2),
    (1 << 6) | ((length >> 11) & 0x03),
    (length >> 3) & 0xff,
    ((length & 0x07) << 5) | 0x1f,
    0xfc,
    ...Array.from({ length: payload }, () => 0),
  ];
}

describe("splitAdtsFrames", () => {
  test("cuts a stream at each frame's own length and times it from its sample rate", () => {
    const frames = splitAdtsFrames(new Uint8Array([...frame(4), ...frame(20), ...frame(9, 3)]));
    expect(frames.map((each) => each.bytes.length)).toEqual([11, 27, 16]);
    expect(frames[0]?.durationMs).toBeCloseTo(46.44, 2); // 1024 samples at 22050 Hz
    expect(frames[2]?.durationMs).toBeCloseTo(21.33, 2); // at 48000 Hz
  });

  test("refuses bytes that are not ADTS rather than sending them as audio", () => {
    expect(() => splitAdtsFrames(new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0, 0, 0]))).toThrow("no syncword");
    expect(() => splitAdtsFrames(new Uint8Array(frame(20).slice(0, 12)))).toThrow("claims 27 bytes");
    expect(() => splitAdtsFrames(new Uint8Array([...frame(4), 0xff, 0xf1]))).toThrow("too short");
  });
});
