// The encoder's stdout framing, shared by every reader of a grid-encoder child.
//
// The child writes `[1 byte kind][4 bytes big-endian length][payload]` and nothing else, so this
// is the one place that has to agree with the helper's writer.

export const KIND_META = 0;

export interface Framed {
  kind: number;
  payload: Uint8Array;
}

/**
 * De-frames the encoder's `[1 byte kind][4 bytes big-endian length][payload]`
 * stdout into `{kind, payload}`.
 */
export async function* frames(stream: ReadableStream<Uint8Array>): AsyncGenerator<Framed> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(0);
  for (;;) {
    while (buffer.length >= 5) {
      const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const length = view.getUint32(1);
      if (buffer.length < 5 + length) break;
      yield { kind: buffer[0]!, payload: buffer.slice(5, 5 + length) };
      buffer = buffer.slice(5 + length);
    }
    const { value, done } = await reader.read();
    if (done) return;
    if (!value) continue;
    const grown = new Uint8Array(buffer.length + value.length);
    grown.set(buffer);
    grown.set(value, buffer.length);
    buffer = grown;
  }
}
