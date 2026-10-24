// The noise bed under the channel: one loop of encoded frames per color and level, and messages
// spliced into it so the noise runs on under a voice with no seam at either end.
//
// AAC frames overlap, so a frame taken from one encoding and put beside a frame from another
// clicks wherever the two disagree: inaudible on white noise, a thump on brown. Two things make
// every join one the encoder already made:
//
// - A loop is encoded as three copies of a periodic stretch of noise, and the middle copy's frames
//   kept: its last frame was encoded running into the same samples its first frame starts with.
// - A message is encoded with the loop's own samples under it, starting `LEAD_IN_FRAMES` before the
//   frame it replaces, so frame `i` of the message decodes to the same stretch of the loop that
//   frame `i` of the loop does, plus the voice. The encoder's delay (its priming, 2112 samples for
//   Apple's) shifts both encodings alike, so it cancels and is never assumed.

import type { AudioNoiseColor } from "@agentdesk/agent-feed-wire";
import type { AdtsFrame } from "@/audio/adtsFrames";
import { noiseLoopSamples } from "@/audio/noiseColors";
import { SAMPLE_RATE } from "@/audio/pcmAudio";
import { encodeAdtsFrames } from "@/audio/speechAudio";

/** Samples in one AAC frame. */
export const FRAME_SAMPLES = 1024;

/** About eight seconds: long enough that no pattern is heard. */
const LOOP_FRAMES = Math.round((8 * SAMPLE_RATE) / FRAME_SAMPLES);

/** Frames a message's encoding runs through before the first one kept, so the encoder has settled. */
const LEAD_IN_FRAMES = 3;

/** Frames past the voice the encoding runs on, so the last frame kept is not the encoder's flush. */
const TAIL_FRAMES = 2;

/** Room for the encoder's delay, more than Apple's 2112 samples, so the voice ends inside the frames kept. */
const DELAY_ALLOWANCE = 4 * FRAME_SAMPLES;

export type Encoder = (samples: Int16Array) => Promise<AdtsFrame[]>;

/** One color and level's loop: its samples, to mix messages into, and its frames, to send. */
export type NoiseBed = { samples: Int16Array; frames: AdtsFrame[] };

/** Makes `color` at `level` into a loop of `loopFrames` frames that repeats without a seam. */
export async function makeNoiseBed(
  color: AudioNoiseColor,
  level: number,
  encode: Encoder,
  loopFrames: number = LOOP_FRAMES,
  random: () => number = Math.random,
): Promise<NoiseBed> {
  const samples = noiseLoopSamples(color, level, loopFrames * FRAME_SAMPLES, random);
  const tiled = new Int16Array(samples.length * 3);
  for (let copy = 0; copy < 3; copy += 1) tiled.set(samples, copy * samples.length);
  const encoded = await encode(tiled);
  if (encoded.length < 2 * loopFrames) {
    throw new Error(`noise ${color} ${level}: ${encoded.length} frames for three copies of ${loopFrames}`);
  }
  return { samples, frames: encoded.slice(loopFrames, 2 * loopFrames) };
}

/**
 * The frames that replace the bed's from `atFrame` (counted along the bed as it repeats) while
 * `speech` plays over it. The bed resumes after them at `atFrame + frames.length`.
 */
export async function spliceMessage(bed: NoiseBed, atFrame: number, speech: Int16Array, encode: Encoder) {
  const loopLength = bed.samples.length;
  const kept = Math.ceil((speech.length + DELAY_ALLOWANCE) / FRAME_SAMPLES);
  const input = new Int16Array((LEAD_IN_FRAMES + kept + TAIL_FRAMES) * FRAME_SAMPLES);
  // Where in the loop the input starts: `LEAD_IN_FRAMES` before the frame being replaced.
  const start = ((((atFrame - LEAD_IN_FRAMES) * FRAME_SAMPLES) % loopLength) + loopLength) % loopLength;
  const voiceAt = LEAD_IN_FRAMES * FRAME_SAMPLES;
  for (let index = 0; index < input.length; index += 1) {
    const noise = bed.samples[(start + index) % loopLength] ?? 0;
    const voice = index >= voiceAt ? (speech[index - voiceAt] ?? 0) : 0;
    input[index] = Math.max(-32_768, Math.min(32_767, noise + voice));
  }
  const encoded = await encode(input);
  if (encoded.length < LEAD_IN_FRAMES + kept) {
    throw new Error(`message: ${encoded.length} frames, needed ${LEAD_IN_FRAMES + kept}`);
  }
  return encoded.slice(LEAD_IN_FRAMES, LEAD_IN_FRAMES + kept);
}

/** Each color and level's bed, made once per process and shared; a failure is dropped so the next try runs. */
const beds = new Map<string, Promise<NoiseBed>>();

export function noiseBed(color: AudioNoiseColor, level: number): Promise<NoiseBed> {
  const key = `${color}:${level}`;
  const known = beds.get(key);
  if (known) return known;
  const making = makeNoiseBed(color, level, encodeAdtsFrames);
  beds.set(key, making);
  making.catch(() => beds.delete(key));
  return making;
}
