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
export interface PcmWorkletAudioFrame {
  readonly type: "frame";
  readonly pcm: ArrayBuffer;
  readonly rms: number;
  readonly peak: number;
}

export interface PcmWorkletFlushed {
  readonly type: "flushed";
  readonly requestID: string;
}

export type PcmWorkletMessage = PcmWorkletAudioFrame | PcmWorkletFlushed;

export const PCM_WORKLET_SOURCE: string = /* js */ `
const FRAME_SAMPLES = ${PCM_FRAME_SAMPLES};

class PcmFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(FRAME_SAMPLES);
    this._offset = 0;
    this._accepting = true;
    this.port.onmessage = (event) => {
      if (event.data?.type !== "flush") {
        return;
      }
      this._accepting = false;
      if (this._offset > 0) {
        this._emit(this._offset);
      }
      this.port.postMessage({
        type: "flushed",
        requestID: event.data.requestID,
      });
    };
  }

  process(inputs) {
    if (!this._accepting) {
      return true;
    }
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
        this._emit(FRAME_SAMPLES);
      }
    }
    return true;
  }

  _emit(sampleCount) {
    const frame = this._buffer;
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < sampleCount; i += 1) {
      const sample = frame[i];
      sumSquares += sample * sample;
      const magnitude = sample < 0 ? -sample : sample;
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
    const rms = Math.sqrt(sumSquares / sampleCount);
    const copy = frame.slice(0, sampleCount);
    this.port.postMessage(
      { type: "frame", pcm: copy.buffer, rms, peak },
      [copy.buffer],
    );
    this._offset = 0;
  }
}

registerProcessor("pcm-frame-processor", PcmFrameProcessor);
`;
