// Noise for the channel's bed, in three colors, made as a loop that repeats without a seam.
//
// Each color is scaled to the same loudness (root mean square) for a level, so a level means the
// same thing whichever color is picked: brown made at white's peak was several times louder.

import type { AudioNoiseColor } from "@agentdesk/agent-feed-wire";
import { noiseAmplitude, SAMPLE_RATE } from "@/audio/pcmAudio";

/** One noise sample per call, roughly unit scale; scaled to its level afterwards. */
type NoiseSource = () => number;

function whiteSource(random: () => number): NoiseSource {
  return () => random() * 2 - 1;
}

/** Paul Kellet's three-pole filter on white: within half a decibel of -3 dB an octave. */
function pinkSource(random: () => number): NoiseSource {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  return () => {
    const white = random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    return b0 + b1 + b2 + white * 0.1848;
  };
}

/** White, summed with a slow leak back to zero so it wanders without drifting off: -6 dB an octave. */
function brownSource(random: () => number): NoiseSource {
  let last = 0;
  return () => {
    last = (last + 0.02 * (random() * 2 - 1)) / 1.02;
    return last;
  };
}

const SOURCES: Record<AudioNoiseColor, (random: () => number) => NoiseSource> = {
  white: whiteSource,
  pink: pinkSource,
  brown: brownSource,
};

/** The loudness, root mean square, a level's noise is scaled to: white's at that level's peak. */
function targetRms(level: number): number {
  return (noiseAmplitude(level) * 32_767) / Math.sqrt(3);
}

/**
 * `length` samples of `color` noise at `level`, periodic: the last sample runs into the first as
 * any sample runs into the next, so it can loop with no click where it starts again. Made by
 * generating past the end and fading that overrun in over the start, equal power so the fade does
 * not dip.
 */
export function noiseLoopSamples(
  color: AudioNoiseColor,
  level: number,
  length: number,
  random: () => number = Math.random,
): Int16Array {
  const loop = new Int16Array(length);
  const rms = targetRms(level);
  if (rms === 0) return loop;
  const fade = Math.min(Math.round(SAMPLE_RATE / 2), Math.floor(length / 2));
  const next = SOURCES[color](random);
  // Settled first: the filters start from rest, and the first stretch of pink or brown is quiet.
  for (let index = 0; index < SAMPLE_RATE; index += 1) next();
  const raw = Float64Array.from({ length: length + fade }, next);
  for (let index = 0; index < fade; index += 1) {
    const share = (index / fade) * (Math.PI / 2);
    raw[index] = (raw[index] ?? 0) * Math.sin(share) + (raw[length + index] ?? 0) * Math.cos(share);
  }
  let sumOfSquares = 0;
  for (let index = 0; index < length; index += 1) sumOfSquares += (raw[index] ?? 0) ** 2;
  const scale = rms / Math.sqrt(sumOfSquares / length);
  for (let index = 0; index < length; index += 1) {
    loop[index] = Math.max(-32_768, Math.min(32_767, Math.round((raw[index] ?? 0) * scale)));
  }
  return loop;
}
