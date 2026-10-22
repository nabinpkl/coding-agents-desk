// The voice's player, run on the audio thread: the Mac's speech queued and time-stretched to the
// listener's speed (WSOLA: overlapping 21 ms frames, each placed where it best continues the last,
// which keeps the pitch). A piece made at the speed it plays at is copied through untouched. Speech
// arrives at 24 kHz and is resampled to the output rate after stretching. It can drop one message
// wherever it sits, which is how a stop from the Mac is heard at once.
//
// The same processor the push page runs (`public/experiments/local-test.html?push=1`), which is a
// static page and cannot import this, so the two are copies: change both.
//
// Messages to its port: {type: "piece", samples, made, pause, message}, {type: "speed", value},
// {type: "drop", message}, {type: "clear"}. It answers {type: "speaking"} and {type: "quiet"}.

/** The processor's name, as `registerProcessor` gives it. */
export const VOICE_PROCESSOR = "voice";

export const VOICE_WORKLET = `
const SRC_RATE = 24000, W = 512, HS = 256, SEEK = 96;
// Periodic Hann: two windows half a frame apart sum to exactly 1.
const WINDOW = Float32Array.from({ length: W }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W));
class Voice extends AudioWorkletProcessor {
  constructor() {
    super();
    this.src = new Float32Array(SRC_RATE * 60);
    this.base = 0; // the absolute sample index src[0] holds
    this.end = 0; // one past the last sample queued
    this.regions = []; // { from, made }: the speed the audio from 'from' on was made at
    this.spans = []; // { message, from, end }: where each message's pieces sit, to drop one
    this.speed = 1;
    this.pos = 0; // where the next frame nominally starts
    this.prev = -1; // where the last frame started; -1 after a silence
    this.acc = new Float32Array(W);
    this.out = new Float32Array(8192); // stretched audio at 24 kHz, a ring
    this.outRead = 0;
    this.outLen = 0;
    this.phase = 0;
    this.speaking = false;
    this.port.onmessage = (event) => this.message(event.data);
  }
  message(data) {
    if (data.type === "speed") this.speed = data.value;
    if (data.type === "clear") {
      this.end = Math.ceil(this.pos);
      this.regions = [];
      this.spans = [];
      this.acc.fill(0);
      this.outLen = 0;
      this.prev = -1;
    }
    if (data.type === "piece") this.append(data.samples, data.made, data.pause, data.message);
    if (data.type === "drop") this.drop(data.message);
  }
  // Cuts one message out, wherever it sits: the rest of it if it is the one being heard, all of
  // it if it is still waiting, and whatever was queued after it closes up behind the cut.
  drop(message) {
    const mine = this.spans.filter((s) => s.message === message);
    if (mine.length === 0) return;
    this.spans = this.spans.filter((s) => s.message !== message);
    const playing = Math.ceil(this.pos);
    const cut0 = Math.max(Math.min(...mine.map((s) => s.from)), playing);
    const cut1 = Math.max(...mine.map((s) => s.end));
    if (cut1 <= cut0) return; // already heard to the end
    const length = cut1 - cut0;
    this.src.copyWithin(cut0 - this.base, cut1 - this.base, this.end - this.base);
    this.end -= length;
    for (const s of this.spans) {
      if (s.from >= cut1) {
        s.from -= length;
        s.end -= length;
      }
    }
    this.regions = this.regions
      .filter((r) => r.from < cut0 || r.from >= cut1)
      .map((r) => (r.from >= cut1 ? { from: r.from - length, made: r.made } : r));
    if (cut0 === playing) {
      // It was the one being heard: what was already stretched from it goes too.
      this.outLen = 0;
      this.acc.fill(0);
      this.prev = -1;
    }
  }
  at(i) {
    return i < this.base || i >= this.end ? 0 : this.src[i - this.base];
  }
  append(samples, made, pause, message) {
    const from = Math.max(this.end, Math.ceil(this.pos));
    const end = from + samples.length + Math.round(pause * SRC_RATE);
    this.spans.push({ message, from, end });
    if (from - this.end > 0 || this.prev < 0) this.prev = -1;
    // Room: drop what has been played, and grow if a long queue still does not fit.
    const keep = Math.max(this.base, Math.floor(this.pos) - W);
    if (end - keep > this.src.length) {
      const grown = new Float32Array(Math.max(this.src.length * 2, end - keep));
      grown.set(this.src.subarray(keep - this.base, this.end - this.base));
      this.src = grown;
    } else if (keep > this.base) {
      this.src.copyWithin(0, keep - this.base, this.end - this.base);
    }
    this.base = keep;
    this.src.fill(0, this.end - this.base, end - this.base);
    this.src.set(samples, from - this.base);
    this.end = end;
    this.regions.push({ from, made });
    this.regions = this.regions.filter((r, i, all) => i === all.length - 1 || all[i + 1].from > this.base);
    this.spans = this.spans.filter((s) => s.end > this.base);
  }
  madeAt(i) {
    let made = this.speed;
    for (const r of this.regions) if (r.from <= i) made = r.made;
    return made;
  }
  hop() {
    const ratio = this.speed / this.madeAt(this.pos);
    let start = Math.round(this.pos);
    if (this.prev >= 0 && Math.abs(ratio - 1) < 0.001) {
      start = this.prev + HS; // made at this speed: the exact continuation, a straight copy
    } else if (this.prev >= 0) {
      const natural = this.prev + HS;
      let best = start;
      let bestScore = -Infinity;
      for (let d = -SEEK; d <= SEEK; d += 2) {
        let score = 0;
        for (let i = 0; i < HS; i += 2) score += this.at(start + d + i) * this.at(natural + i);
        if (score > bestScore) {
          bestScore = score;
          best = start + d;
        }
      }
      start = best;
    }
    for (let i = 0; i < W; i += 1) this.acc[i] += WINDOW[i] * this.at(start + i);
    for (let i = 0; i < HS; i += 1) {
      this.out[(this.outRead + this.outLen) % this.out.length] = this.acc[i];
      this.outLen += 1;
    }
    this.acc.copyWithin(0, HS);
    this.acc.fill(0, W - HS);
    this.prev = start;
    this.pos = Math.abs(ratio - 1) < 0.001 ? start + HS : this.pos + HS * ratio;
  }
  process(_, outputs) {
    const channel = outputs[0][0];
    const step = SRC_RATE / sampleRate;
    const need = Math.ceil(channel.length * step) + 2;
    // Frames are made while there is speech to make them from, and a frame past its end so the
    // last one's tail is heard; after that the queue is silent and costs nothing.
    while (this.outLen < need && this.pos < this.end + W) this.hop();
    for (let i = 0; i < channel.length; i += 1) {
      if (this.outLen < 2) {
        channel[i] = 0;
        continue;
      }
      const a = this.out[this.outRead];
      const b = this.out[(this.outRead + 1) % this.out.length];
      channel[i] = a + (b - a) * this.phase;
      this.phase += step;
      while (this.phase >= 1 && this.outLen > 1) {
        this.phase -= 1;
        this.outRead = (this.outRead + 1) % this.out.length;
        this.outLen -= 1;
      }
    }
    const speaking = this.pos < this.end;
    if (speaking !== this.speaking) {
      this.speaking = speaking;
      this.port.postMessage({ type: speaking ? "speaking" : "quiet" });
    }
    return true;
  }
}
registerProcessor("voice", Voice);
`;

/**
 * The tone before a message, so the kind of news is heard before its words: two rising notes for
 * one that needs you, one soft note for one that is done. Made at the player's 24 kHz.
 */
export function toneSamples(tone: "attention" | "done"): Float32Array {
  const notes: [number, number][] =
    tone === "attention"
      ? [
          [660, 0.09],
          [880, 0.12],
        ]
      : [[523, 0.14]];
  const gap = 0.04;
  const out = new Float32Array(Math.round(24000 * (notes.reduce((sum, [, s]) => sum + s + gap, 0) + 0.12)));
  let at = 0;
  for (const [frequency, seconds] of notes) {
    const length = Math.round(24000 * seconds);
    for (let i = 0; i < length; i += 1) {
      const envelope = Math.min(1, i / 240, (length - i) / 480); // 10 ms in, 20 ms out: no click
      out[at + i] = 0.22 * envelope * Math.sin((2 * Math.PI * frequency * i) / 24000);
    }
    at += length + Math.round(24000 * gap);
  }
  return out;
}
