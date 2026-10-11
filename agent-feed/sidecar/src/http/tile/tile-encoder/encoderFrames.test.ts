import { describe, expect, test } from "bun:test";
import { frames, KIND_META, type Framed } from "@/http/tile/tile-encoder/encoderFrames";

function framed(kind: number, payload: number[]): number[] {
  return [kind, 0, 0, 0, payload.length, ...payload];
}

function chunks(...parts: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new Uint8Array(part));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Framed[]> {
  const out: Framed[] = [];
  for await (const frame of frames(stream)) out.push(frame);
  return out;
}

describe("encoder stdout framing", () => {
  test("reads a frame's kind and payload", async () => {
    const [frame, ...rest] = await collect(chunks(framed(KIND_META, [7, 8])));
    expect(rest).toEqual([]);
    expect(frame!.kind).toBe(KIND_META);
    expect([...frame!.payload]).toEqual([7, 8]);
  });

  test("a frame split across reads is one frame, and one read carrying several is several", async () => {
    // The child flushes when it has bytes, not when it has whole frames, so neither shape is rare.
    const whole = framed(3, [1, 2, 3]);
    expect((await collect(chunks(whole.slice(0, 2), whole.slice(2, 6), whole.slice(6)))).length).toBe(1);
    expect((await collect(chunks([...framed(3, [1]), ...framed(4, [2])]))).length).toBe(2);
  });

  test("a truncated trailing frame is dropped rather than yielded short", async () => {
    expect(await collect(chunks([...framed(3, [1]), ...framed(3, [9, 9]).slice(0, 5)]))).toHaveLength(1);
  });

  test("a zero-length payload is still a frame, which is how a bare marker arrives", async () => {
    expect(await collect(chunks(framed(2, [])))).toEqual([{ kind: 2, payload: new Uint8Array(0) }]);
  });
});
