// Raw audio for the channel: 16-bit mono samples at the rate `say` speaks, read from and written to
// WAV, and how loud each noise level is. The noise itself is `noiseColors.ts`.

import { AUDIO_NOISE_LEVEL_MAX } from "@agentdesk/agent-feed-wire";

/** The rate `say` is asked for and everything here is made at. */
export const SAMPLE_RATE = 22_050;

/** The loudest noise, at level `AUDIO_NOISE_LEVEL_MAX`, as a fraction of full scale. */
const NOISE_PEAK = 0.3;

/** `level` as a whole step from 0 to `AUDIO_NOISE_LEVEL_MAX`. */
export function clampNoiseLevel(level: number): number {
  return Math.min(AUDIO_NOISE_LEVEL_MAX, Math.max(0, Math.round(level)));
}

/**
 * A level's noise amplitude, 0 to 1 of full scale. Squared, because loudness is heard on a log
 * scale: a straight line put all the change in the first few steps.
 */
export function noiseAmplitude(level: number): number {
  const step = clampNoiseLevel(level) / AUDIO_NOISE_LEVEL_MAX;
  return NOISE_PEAK * step * step;
}

/** The samples of a 16-bit PCM mono WAV, walking its chunks: `say` puts a padding chunk first. */
export function readWav(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("WAV: not a RIFF WAVE file");
  let format: { channels: number; rate: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      format = {
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) throw new Error("WAV: data before fmt");
      if (format.channels !== 1 || format.bits !== 16 || format.rate !== SAMPLE_RATE) {
        throw new Error(
          `WAV: expected 16-bit mono at ${SAMPLE_RATE} Hz, got ${format.bits}-bit, ${format.channels} channel(s), ${format.rate} Hz`,
        );
      }
      const end = Math.min(body + size, bytes.length);
      const samples = new Int16Array(Math.floor((end - body) / 2));
      for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(body + index * 2, true);
      return samples;
    }
    at = body + size + (size % 2);
  }
  throw new Error("WAV: no data chunk");
}

/** `samples` as a 16-bit PCM mono WAV at `SAMPLE_RATE`. */
export function writeWav(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const put = (at: number, text: string) =>
    [...text].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  put(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  put(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}
