// The speech process's push stream as frames (`speech_server.py`, `GET /listen`): uint32 LE header
// length, JSON header, uint32 LE PCM byte length, float32 mono PCM at 24 kHz. The network splits it
// wherever it likes, so bytes are held until a whole frame is in.

/** What a frame's header carries: the first frame of a message names its voice and tone. */
export type RadioHeader = {
  message?: number;
  index?: number;
  tone?: "attention" | "done";
  /** A stop frame (no audio): drop what is held of this message. */
  stop?: number;
};

export type RadioFrame = { header: RadioHeader; samples: Float32Array };

/** Feeds bytes in as they arrive and hands out each whole frame; an empty one is a keepalive. */
export function createFrameReader(onFrame: (frame: RadioFrame) => void): (bytes: Uint8Array) => void {
  let pending: Uint8Array = new Uint8Array(0);
  const decoder = new TextDecoder();
  return (bytes) => {
    const joined = new Uint8Array(pending.length + bytes.length);
    joined.set(pending);
    joined.set(bytes, pending.length);
    pending = joined;
    for (;;) {
      if (pending.length < 4) return;
      const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
      const headerLength = view.getUint32(0, true);
      if (pending.length < 8 + headerLength) return;
      const pcmLength = view.getUint32(4 + headerLength, true);
      const end = 8 + headerLength + pcmLength;
      if (pending.length < end) return;
      const header = JSON.parse(decoder.decode(pending.subarray(4, 4 + headerLength))) as RadioHeader;
      // Copied, so the samples start on a four-byte boundary.
      const samples = new Float32Array(pending.slice(8 + headerLength, end).buffer);
      pending = pending.slice(end);
      onFrame({ header, samples });
    }
  };
}
