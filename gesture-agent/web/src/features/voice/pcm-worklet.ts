/**
 * Source for the AudioWorklet that runs on the audio-render thread. It is
 * loaded as a Blob module (see `use-mic-capture`) so no static asset file or
 * bundler worklet-loader config is required.
 *
 * The processor accumulates mono input into fixed-size frames, computes an RMS
 * and peak per frame for a responsive local meter, and posts each frame's
 * Float32 samples (as a transferable ArrayBuffer) back to the main thread. It
 * applies no gain: preamp is a session parameter owned by the server.
 */

/** Samples per emitted frame at the capture rate (~128ms at 16 kHz). */
export const PCM_FRAME_SAMPLES = 2048;

/** Shape of every message posted from the worklet to the main thread. */
export interface PcmWorkletFrame {
  readonly pcm: ArrayBuffer;
  readonly rms: number;
  readonly peak: number;
}

export const PCM_WORKLET_SOURCE: string = /* js */ `
const FRAME_SAMPLES = ${PCM_FRAME_SAMPLES};

class PcmFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(FRAME_SAMPLES);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }
    const channel = input[0];
    if (!channel) {
      return true;
    }

    for (let i = 0; i < channel.length; i += 1) {
      this._buffer[this._offset] = channel[i];
      this._offset += 1;
      if (this._offset === FRAME_SAMPLES) {
        this._emit();
      }
    }
    return true;
  }

  _emit() {
    const frame = this._buffer;
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      const sample = frame[i];
      sumSquares += sample * sample;
      const magnitude = sample < 0 ? -sample : sample;
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
    const rms = Math.sqrt(sumSquares / FRAME_SAMPLES);
    const copy = frame.slice(0);
    this.port.postMessage(
      { pcm: copy.buffer, rms, peak },
      [copy.buffer],
    );
    this._offset = 0;
  }
}

registerProcessor("pcm-frame-processor", PcmFrameProcessor);
`;
