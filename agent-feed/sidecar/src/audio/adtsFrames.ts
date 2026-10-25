// AAC in ADTS framing, cut into its frames.
//
// ADTS is what lets separately encoded pieces of audio be sent one after another as one stream:
// every frame carries its own header, so a decoder can start at any frame and does not care that
// the frames came from different files. The pacer sends them by the frame, at the rate they play.

/** Samples in one AAC raw data block. */
const SAMPLES_PER_BLOCK = 1024;
const HEADER_BYTES = 7;

/** Indexed by the header's 4-bit sampling-frequency index (ISO/IEC 14496-3). */
const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

export type AdtsFrame = {
  bytes: Uint8Array;
  /** How long the frame plays, in milliseconds. */
  durationMs: number;
};

/** Splits an ADTS byte stream into its frames, throwing on anything that is not one. */
export function splitAdtsFrames(bytes: Uint8Array): AdtsFrame[] {
  const frames: AdtsFrame[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < HEADER_BYTES) {
      throw new Error(`ADTS: ${bytes.length - offset} trailing bytes at ${offset}, too short for a header`);
    }
    const b1 = bytes[offset + 1] ?? 0;
    if (bytes[offset] !== 0xff || (b1 & 0xf0) !== 0xf0) throw new Error(`ADTS: no syncword at ${offset}`);
    const b2 = bytes[offset + 2] ?? 0;
    const b3 = bytes[offset + 3] ?? 0;
    const b4 = bytes[offset + 4] ?? 0;
    const b5 = bytes[offset + 5] ?? 0;
    const b6 = bytes[offset + 6] ?? 0;
    const sampleRate = SAMPLE_RATES[(b2 >> 2) & 0x0f];
    if (sampleRate === undefined) throw new Error(`ADTS: reserved sampling-frequency index at ${offset}`);
    const length = ((b3 & 0x03) << 11) | (b4 << 3) | ((b5 & 0xe0) >> 5);
    if (length < HEADER_BYTES || offset + length > bytes.length) {
      throw new Error(`ADTS: frame at ${offset} claims ${length} bytes, ${bytes.length - offset} remain`);
    }
    const blocks = (b6 & 0x03) + 1;
    frames.push({
      bytes: bytes.subarray(offset, offset + length),
      durationMs: (blocks * SAMPLES_PER_BLOCK * 1000) / sampleRate,
    });
    offset += length;
  }
  return frames;
}
