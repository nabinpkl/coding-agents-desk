/**
 * Encode a Float32 PCM frame as base64, matching the wire contract's
 * `audioFrame.pcm` with `encoding: "float32"`. The bytes are the little-endian
 * IEEE-754 samples exactly as produced by the capture graph.
 */

export function encodeFloat32Pcm(samples: Float32Array): string {
  const bytes = new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  // btoa needs a binary string; build it in chunks to avoid blowing the call
  // stack on large frames.
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const slice = bytes.subarray(offset, offset + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
