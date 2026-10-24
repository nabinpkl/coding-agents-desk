import { describe, expect, test } from "bun:test";
import { clampLevel, noiseAmplitude, readWav, voiceGain, writeWav } from "@/audio/pcmAudio";

describe("samples for the audio channel", () => {
  test("a WAV written here reads back as the same samples", () => {
    const samples = new Int16Array([0, 1, -1, 32_767, -32_768, 1234]);
    expect([...readWav(writeWav(samples))]).toEqual([...samples]);
  });

  test("a WAV with a chunk before its data, as say writes one, still reads", () => {
    const plain = writeWav(new Int16Array([5, -5]));
    const padding = new Uint8Array([0x46, 0x4c, 0x4c, 0x52, 4, 0, 0, 0, 0, 0, 0, 0]); // "FLLR", 4 bytes
    const padded = new Uint8Array([...plain.subarray(0, 36), ...padding, ...plain.subarray(36)]);
    expect([...readWav(padded)]).toEqual([5, -5]);
  });

  test("a WAV in another shape is refused rather than misread", () => {
    const stereo = writeWav(new Int16Array(4));
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => readWav(stereo)).toThrow("expected 16-bit mono");
    expect(() => readWav(new Uint8Array(12))).toThrow("not a RIFF WAVE");
  });

  test("noise levels run 0 to 10, quietest is silence, and loudness grows by the square", () => {
    expect([-3, 0, 4.6, 10, 40].map(clampLevel)).toEqual([0, 0, 5, 10, 10]);
    expect(noiseAmplitude(0)).toBe(0);
    expect(noiseAmplitude(5)).toBeCloseTo(0.075);
    expect(noiseAmplitude(10)).toBeCloseTo(0.3);
  });

  test("the voice is silent at 0, about as spoken at 8, and as loud as it goes unclipped at 10", () => {
    expect(voiceGain(0)).toBe(0);
    expect(voiceGain(8)).toBeCloseTo(0.93, 2);
    expect(voiceGain(10)).toBeCloseTo(1.45);
    // say peaks at about 0.69 of full scale, so the top level stays just inside it.
    expect(0.69 * voiceGain(10)).toBeLessThan(1.01);
  });
});
