// Noise for the push page's bed (`local-test.html`), shaped for where it is heard. A classic script:
// it sets `window.NoiseShaping`, and runs under Node too, for measuring.
//
// Three shapings of each color:
//
// - "original": the page's first noise, mono, kept to compare against. Its brown leaks back to zero
//   fast enough to flatten everything below about 150 Hz at 48 kHz.
// - "headphones": the textbook slopes (white flat, pink -3 dB an octave, brown -6 dB an octave down
//   to 20 Hz), a separate noise in each ear so it is wide rather than in the middle of the head.
// - "speaker": for a phone's speaker, which plays almost nothing below a few hundred Hz. What it
//   cannot play is cut, so the phone's speaker limiter is not spent on it; harmonics of that low
//   rumble are added where the speaker can play them, so the ear hears the low note anyway (the
//   "missing fundamental", how small speakers seem to have bass); the low mids are lifted for
//   warmth; the top is softened. Stereo too, for the phone's two speakers.
//
// Levels are matched by what is heard rather than by total power: each shaping is scaled so its
// loudness, weighted roughly as the ear and the playback weigh it, equals the original pink's.
(() => {
  /** Robert Bristow-Johnson's biquad coefficients, for `type` at `f0` Hz. */
  function biquad(type, f0, rate, { q = Math.SQRT1_2, gainDb = 0 } = {}) {
    const w = (2 * Math.PI * f0) / rate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a = 10 ** (gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === "lowpass") {
      [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * cos, 1 - alpha];
    } else if (type === "highpass") {
      [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
      [a0, a1, a2] = [1 + alpha, -2 * cos, 1 - alpha];
    } else if (type === "peaking") {
      [b0, b1, b2] = [1 + alpha * a, -2 * cos, 1 - alpha * a];
      [a0, a1, a2] = [1 + alpha / a, -2 * cos, 1 - alpha / a];
    } else if (type === "highshelf") {
      const s = 2 * Math.sqrt(a) * alpha;
      [b0, b1, b2] = [a * (a + 1 + (a - 1) * cos + s), -2 * a * (a - 1 + (a + 1) * cos), a * (a + 1 + (a - 1) * cos - s)];
      [a0, a1, a2] = [a + 1 - (a - 1) * cos + s, 2 * (a - 1 - (a + 1) * cos), a + 1 - (a - 1) * cos - s];
    } else throw new Error(`no ${type} filter`);
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }

  /** Runs `data` through each filter in turn, in place. */
  function filter(data, ...filters) {
    for (const { b0, b1, b2, a1, a2 } of filters) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < data.length; i += 1) {
        const x = data[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        data[i] = y;
      }
    }
    return data;
  }

  function rms(data, length = data.length) {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += data[i] * data[i];
    return Math.sqrt(sum / length);
  }

  /** One sample per call, roughly unit scale. `rate` sets where brown's bass stops. */
  const SOURCES = {
    white: () => () => Math.random() * 2 - 1,
    // Kellet's refined filter on white: within a twentieth of a decibel of -3 dB an octave.
    pink: () => {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      return () => {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;
        return out;
      };
    },
    // The original brown: a leak of 1/1.02 a sample, which levels off below about 150 Hz at 48 kHz.
    originalBrown: () => {
      let last = 0;
      return () => (last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02);
    },
    // Brown down to its 20 Hz cut: a leak only fast enough to stop it wandering (5 Hz).
    brown: (rate) => {
      let last = 0;
      const leak = 1 - (2 * Math.PI * 5) / rate;
      return () => (last = leak * last + 0.02 * (Math.random() * 2 - 1));
    },
  };

  /** `length` samples of `color`, run in for a second first: the filters start from rest. */
  function raw(color, shape, length, rate) {
    const name = color === "brown" && shape === "original" ? "originalBrown" : color;
    const next = SOURCES[name](rate);
    for (let i = 0; i < rate; i += 1) next();
    const data = new Float32Array(length);
    for (let i = 0; i < length; i += 1) data[i] = next();
    if (name === "brown") filter(data, biquad("highpass", 20, rate), biquad("highpass", 20, rate));
    return data;
  }

  /** Below this the phone's speaker plays next to nothing. */
  const SPEAKER_LOW_HZ = 150;
  /** The rumble whose harmonics are added: what the speaker cannot play. */
  const RUMBLE_HZ = 180;

  /**
   * Harmonics of the low rumble, kept where the speaker plays them. A gentle curve that saturates,
   * on the rumble at unit loudness: its odd part (tanh) makes the third harmonic and up, its even
   * part (the magnitude) the second, and band-limiting to 200 to 1200 Hz keeps those and drops the
   * fundamental the speaker could not play anyway. Unit loudness out.
   */
  function rumbleHarmonics(data, rate) {
    const low = filter(Float32Array.from(data), biquad("lowpass", RUMBLE_HZ, rate), biquad("lowpass", RUMBLE_HZ, rate));
    const scale = 1 / (rms(low) || 1);
    const out = new Float32Array(data.length);
    for (let i = 0; i < low.length; i += 1) {
      const u = low[i] * scale;
      out[i] = 0.7 * Math.tanh(1.5 * u) + 0.5 * Math.abs(Math.tanh(u));
    }
    filter(
      out,
      biquad("highpass", 200, rate),
      biquad("highpass", 200, rate),
      biquad("lowpass", 1200, rate),
      biquad("lowpass", 1200, rate),
    );
    const outRms = rms(out) || 1;
    for (let i = 0; i < out.length; i += 1) out[i] /= outRms;
    return out;
  }

  /**
   * The speaker shaping. `fullness` 0 to 10 sets how loud the harmonics are against what the
   * speaker already plays of the noise; `softness` 0 to 10 cuts the top, up to 15 dB above 3 kHz.
   */
  function forSpeaker(data, rate, { fullness, softness }) {
    // Taken first, from the rumble the cut below then removes.
    const harmonics = fullness > 0 ? rumbleHarmonics(data, rate) : null;
    filter(data, biquad("highpass", SPEAKER_LOW_HZ, rate), biquad("highpass", SPEAKER_LOW_HZ, rate));
    if (harmonics) {
      const audible = filter(Float32Array.from(data), biquad("lowpass", 2000, rate));
      const gain = (fullness / 10) * 1.2 * rms(audible);
      for (let i = 0; i < data.length; i += 1) data[i] += gain * harmonics[i];
    }
    filter(
      data,
      biquad("peaking", 450, rate, { q: 0.8, gainDb: 5 }),
      biquad("highshelf", 3000, rate, { gainDb: -1.5 * softness }),
      biquad("lowpass", 12000, rate),
    );
    return data;
  }

  /** Loudness as heard, roughly: what each playback carries, the top weighted up as the ear does. */
  function heardLoudness(data, length, rate, shape) {
    const weighted = filter(
      Float32Array.from(data.subarray(0, length)),
      biquad("highpass", shape === "speaker" ? 300 : 60, rate),
      biquad("highshelf", 1500, rate, { gainDb: 4 }),
    );
    return rms(weighted);
  }

  /** The original pink's heard loudness at `targetRms`, which every shaping is matched to. */
  const references = new Map();
  function referenceLoudness(shape, rate, targetRms) {
    const key = `${shape}|${rate}`;
    if (!references.has(key)) {
      const length = rate * 4;
      const pink = raw("pink", "original", length, rate);
      const scale = 1 / rms(pink);
      for (let i = 0; i < length; i += 1) pink[i] *= scale;
      references.set(key, heardLoudness(pink, length, rate, shape));
    }
    return references.get(key) * targetRms;
  }

  /**
   * One channel of `length` samples that loops without a seam: made past its end, shaped over all
   * of it, and the overrun faded in over the start, equal power, so the last sample runs into the
   * first as any sample runs into the next.
   */
  function channel(color, shape, length, rate, options) {
    const fade = Math.round(rate / 2);
    const data = raw(color, shape, length + fade, rate);
    if (shape === "speaker") forSpeaker(data, rate, options);
    for (let i = 0; i < fade; i += 1) {
      const share = (i / fade) * (Math.PI / 2);
      data[i] = data[i] * Math.sin(share) + data[length + i] * Math.cos(share);
    }
    return data.subarray(0, length);
  }

  /**
   * `color` shaped for `shape`, as channels of Float32 samples at `rate`: one for "original", two
   * otherwise. `targetRms` is the original's loudness (its RMS; the others are matched to its pink by
   * ear). Returns `{channels, scale, shortDb, peak}`, the last three for the log.
   */
  function make({ color, shape, rate, seconds = 8, targetRms, fullness = 6, softness = 6 }) {
    const length = Math.round(rate * seconds);
    const count = shape === "original" ? 1 : 2;
    const channels = Array.from({ length: count }, () => channel(color, shape, length, rate, { fullness, softness }));
    let scale;
    if (shape === "original") {
      scale = targetRms / rms(channels[0]);
    } else {
      const heard = channels.reduce((sum, data) => sum + heardLoudness(data, length, rate, shape), 0) / count;
      scale = referenceLoudness(shape, rate, targetRms) / heard;
    }
    let peak = 0;
    for (const data of channels) for (let i = 0; i < length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
    // Never past full scale: deep brown carries a great deal of power below what is weighted.
    const capped = Math.min(scale, 0.98 / (peak || 1));
    for (const data of channels) for (let i = 0; i < length; i += 1) data[i] *= capped;
    // How far the cap left it below the matched loudness, in dB; 0 when it was not needed.
    const shortDb = 20 * Math.log10(scale / capped);
    return { channels, scale: capped, shortDb, peak: peak * capped };
  }

  /** `make` into an AudioBuffer for `context`. */
  function loop(context, options) {
    const { channels, ...about } = make({ ...options, rate: context.sampleRate });
    const buffer = context.createBuffer(channels.length, channels[0].length, context.sampleRate);
    channels.forEach((data, index) => buffer.copyToChannel(data, index));
    return { buffer, ...about };
  }

  const api = { make, loop, biquad, filter };
  if (typeof window !== "undefined") window.NoiseShaping = api;
  if (typeof module !== "undefined") module.exports = api;
})();
