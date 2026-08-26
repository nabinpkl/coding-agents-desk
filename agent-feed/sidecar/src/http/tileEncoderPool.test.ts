import { describe, expect, test } from "bun:test";
import {
  createTileEncoderPool,
  KIND_INIT,
  KIND_MEDIA,
  KIND_META,
  TileEncoderError,
  type EncoderProcess,
  type Framed,
} from "./tileEncoderPool.ts";

function meta(object: Record<string, unknown>): Framed {
  return { kind: KIND_META, payload: new TextEncoder().encode(JSON.stringify(object)) };
}

function segment(byte: number): Framed {
  return { kind: KIND_MEDIA, payload: new Uint8Array([byte]) };
}

/**
 * A scripted encoder: yields queued frames, then waits until more are pushed
 * or it is ended. Mirrors the real child closely enough that the pool cannot
 * tell the difference.
 */
function fakeEncoder() {
  const pending: Framed[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  let killed = 0;
  async function* generate(): AsyncGenerator<Framed> {
    for (;;) {
      const next = pending.shift();
      if (next) {
        yield next;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = null;
    }
  }
  const process: EncoderProcess = {
    frames: generate(),
    kill: () => {
      killed += 1;
      ended = true;
      notify?.();
    },
    failureDetail: () => Promise.resolve("scripted failure"),
  };
  return {
    process,
    push: (...framed: Framed[]) => {
      pending.push(...framed);
      notify?.();
    },
    end: () => {
      ended = true;
      notify?.();
    },
    killCount: () => killed,
  };
}

function readyEncoder() {
  const encoder = fakeEncoder();
  encoder.push(meta({ type: "codec", codec: "hvc1.1.6.L90.B0" }), {
    kind: KIND_INIT,
    payload: new Uint8Array([9, 9]),
  });
  return encoder;
}

async function next(generator: AsyncGenerator<Uint8Array>): Promise<Uint8Array | null> {
  const result = await generator.next();
  return result.done ? null : result.value;
}

describe("createTileEncoderPool", () => {
  test("two concurrent acquires share one encoder", async () => {
    let spawns = 0;
    const encoder = readyEncoder();
    const pool = createTileEncoderPool(() => {
      spawns += 1;
      return encoder.process;
    });
    const [a, b] = await Promise.all([pool.acquire("k"), pool.acquire("k")]);
    expect(spawns).toBe(1);
    expect(a.codec).toBe("hvc1.1.6.L90.B0");
    expect(b.init).toEqual(new Uint8Array([9, 9]));
    encoder.push(segment(1));
    expect(await next(a.segments)).toEqual(new Uint8Array([1]));
    expect(await next(b.segments)).toEqual(new Uint8Array([1]));
    a.release();
    b.release();
  });

  test("different keys get different encoders", async () => {
    const spawned: string[] = [];
    const pool = createTileEncoderPool((key) => {
      spawned.push(key);
      return readyEncoder().process;
    });
    await Promise.all([pool.acquire("k1"), pool.acquire("k2")]);
    expect(spawned).toEqual(["k1", "k2"]);
  });

  test("a slow subscriber drops oldest segments instead of growing", async () => {
    const encoder = readyEncoder();
    const pool = createTileEncoderPool(() => encoder.process);
    const subscription = await pool.acquire("k");
    for (let i = 1; i <= 12; i += 1) encoder.push(segment(i));
    // Let the pump drain the fake's queue.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Queue limit is 8: the first four segments are gone, and playback can
    // resume at 5 because every segment opens on a sync sample.
    expect(await next(subscription.segments)).toEqual(new Uint8Array([5]));
    expect(await next(subscription.segments)).toEqual(new Uint8Array([6]));
    subscription.release();
  });

  test("a subscriber joining late gets the init segment and only new media", async () => {
    const encoder = readyEncoder();
    const pool = createTileEncoderPool(() => encoder.process);
    const first = await pool.acquire("k");
    encoder.push(segment(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const late = await pool.acquire("k");
    expect(late.init).toEqual(new Uint8Array([9, 9]));
    encoder.push(segment(2));
    expect(await next(late.segments)).toEqual(new Uint8Array([2]));
    first.release();
    late.release();
  });

  test("an encoder that reports an error rejects the acquire with its message", async () => {
    const encoder = fakeEncoder();
    encoder.push(meta({ type: "error", message: "window is not shareable" }));
    const pool = createTileEncoderPool(() => encoder.process);
    expect(pool.acquire("k")).rejects.toThrow("window is not shareable");
  });

  test("an encoder that exits before video rejects with its stderr", async () => {
    const encoder = fakeEncoder();
    encoder.end();
    const pool = createTileEncoderPool(() => encoder.process);
    let caught: unknown;
    try {
      await pool.acquire("k");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TileEncoderError);
    expect((caught as TileEncoderError).message).toBe("scripted failure");
  });

  test("encoder death ends every subscriber's segment stream", async () => {
    const encoder = readyEncoder();
    const pool = createTileEncoderPool(() => encoder.process);
    const subscription = await pool.acquire("k");
    encoder.end();
    expect(await next(subscription.segments)).toBeNull();
    expect(pool.size()).toBe(0);
  });

  test("a reader that stops pulling while segments wait is cut; the last cut kills the encoder", async () => {
    const encoder = readyEncoder();
    const pool = createTileEncoderPool(() => encoder.process, {
      idleLimitMs: 30,
      sweepIntervalMs: 10,
      lingerMs: 10,
    });
    const subscription = await pool.acquire("k");
    // Never pull. Segments pile up in the queue, which is what a dead
    // transport looks like from here.
    encoder.push(segment(1), segment(2));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(pool.size()).toBe(0);
    expect(encoder.killCount()).toBeGreaterThan(0);
    // The stream a cut subscriber holds ends rather than hangs.
    expect(await next(subscription.segments)).toEqual(new Uint8Array([1]));
    expect(await next(subscription.segments)).toEqual(new Uint8Array([2]));
    expect(await next(subscription.segments)).toBeNull();
  });

  test("a reader waiting on a quiet window is NOT cut", async () => {
    const encoder = readyEncoder();
    const pool = createTileEncoderPool(() => encoder.process, {
      idleLimitMs: 30,
      sweepIntervalMs: 10,
    });
    const subscription = await pool.acquire("k");
    // Consume nothing because there is nothing: the queue stays empty.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(pool.size()).toBe(1);
    // Still live: a late segment reaches the reader.
    encoder.push(segment(7));
    expect(await next(subscription.segments)).toEqual(new Uint8Array([7]));
    subscription.release();
  });

  test("release is idempotent and a dead entry is not reused", async () => {
    const encoders: ReturnType<typeof readyEncoder>[] = [];
    const pool = createTileEncoderPool(() => {
      const encoder = readyEncoder();
      encoders.push(encoder);
      return encoder.process;
    });
    const first = await pool.acquire("k");
    first.release();
    first.release();
    encoders[0]!.end();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await pool.acquire("k");
    expect(encoders.length).toBe(2);
    second.release();
  });
});
