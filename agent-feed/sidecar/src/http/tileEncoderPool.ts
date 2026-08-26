// One live encoder per (window, geometry), shared by every reader.
//
// Two captures of the same window racing at startup starve one of them.
// Measured: spawned 48ms apart, the first produced its init segment in 850ms
// and the second never received a single frame; 300ms apart both were fine.
// React's strict-mode double-fetch makes that exact race the common case for
// the panel, not a corner, so the pool removes the race by construction: the
// second request for a window joins the first request's encoder instead of
// spawning a competitor.
//
// Sharing has a second, quieter job. The pool's pump is ALWAYS the consumer of
// the child's stdout. An unconsumed child pipe in Bun was observed to wedge
// stdout delivery for every later spawn in the same process, which turned one
// abandoned request into a sidecar that could never serve a tile again until
// restart. With the pump draining eagerly and per-subscriber queues holding
// the buffered side, that state is unreachable.
//
// Slow or stalled subscribers do not slow the capture and do not grow memory:
// each subscriber holds a small queue of segments, and the oldest is dropped
// when it overflows. Dropping whole segments is safe because the muxer opens
// every segment on a sync sample - a segment is a GOP - so any segment can
// follow any other under MSE sequence mode.

export const KIND_META = 0;
export const KIND_INIT = 1;
export const KIND_MEDIA = 2;

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

/** What the pool needs from a spawned encoder; injected so tests need no child process. */
export interface EncoderProcess {
  frames: AsyncGenerator<Framed>;
  kill(): void;
  /** Stderr text, for the error message when the encoder dies before video. */
  failureDetail(): Promise<string>;
}

export interface TileSubscription {
  codec: string;
  init: Uint8Array;
  /** Media segments from subscription time onward. Ends when the encoder does. */
  segments: AsyncGenerator<Uint8Array>;
  /** Detach. The encoder dies shortly after its last subscriber does. */
  release(): void;
}

export class TileEncoderError extends Error {
  constructor(
    readonly code: "tile-encoder-failed" | "tile-encoder-timeout",
    message: string,
  ) {
    super(message);
  }
}

interface Subscriber {
  queue: Uint8Array[];
  notify: (() => void) | null;
  ended: boolean;
  /** Last time the reader asked for a segment. Liveness, not politeness. */
  lastPullAt: number;
  release: () => void;
}

interface Entry {
  ready: Promise<{ codec: string; init: Uint8Array }>;
  subscribers: Set<Subscriber>;
  process: EncoderProcess;
  ended: boolean;
  linger: ReturnType<typeof setTimeout> | null;
  sweeper: ReturnType<typeof setInterval> | null;
}

/** Segments a slow subscriber may hold before its oldest is dropped. */
const SUBSCRIBER_QUEUE_LIMIT = 8;
/**
 * A reader that has not pulled for this long is gone, whatever the transport
 * says. Neither Bun's request.signal nor its stream cancel fired on a client
 * disconnect (measured through the dev proxy AND direct), so the pool cannot
 * wait to be told; a healthy MSE feed loop pulls several times a second, and
 * ten silent seconds at tile bitrates means more than a megabyte is sitting
 * unread somewhere. Cutting that reader costs a reconnect, which is cheap.
 */
const SUBSCRIBER_IDLE_LIMIT_MS = 10_000;
const SWEEP_INTERVAL_MS = 2_000;
/** How long an encoder outlives its last subscriber, to absorb quick re-subscribes. */
const LINGER_MS = 3_000;
/** A healthy encoder emits its init segment inside a second. */
const INIT_DEADLINE_MS = 15_000;

export interface TileEncoderPoolTimings {
  idleLimitMs?: number;
  sweepIntervalMs?: number;
  lingerMs?: number;
}

export function createTileEncoderPool(
  spawn: (key: string) => EncoderProcess,
  timings: TileEncoderPoolTimings = {},
) {
  const idleLimitMs = timings.idleLimitMs ?? SUBSCRIBER_IDLE_LIMIT_MS;
  const sweepIntervalMs = timings.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  const lingerMs = timings.lingerMs ?? LINGER_MS;
  const entries = new Map<string, Entry>();

  function drop(key: string, entry: Entry) {
    if (entries.get(key) === entry) entries.delete(key);
    entry.ended = true;
    if (entry.linger) clearTimeout(entry.linger);
    if (entry.sweeper) clearInterval(entry.sweeper);
    entry.process.kill();
    for (const subscriber of entry.subscribers) {
      subscriber.ended = true;
      subscriber.notify?.();
    }
    entry.subscribers.clear();
  }

  function start(key: string): Entry {
    const process = spawn(key);
    let resolveReady!: (value: { codec: string; init: Uint8Array }) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<{ codec: string; init: Uint8Array }>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const entry: Entry = { subscribers: new Set(), process, ended: false, linger: null, sweeper: null, ready };
    entry.sweeper = setInterval(() => {
      const cutoff = Date.now() - idleLimitMs;
      for (const subscriber of [...entry.subscribers]) {
        // Idle means not pulling WHILE segments wait. An empty queue is a
        // reader that has consumed everything, which is healthy no matter how
        // quiet the window is; a static window produces nothing and must not
        // get its viewer cut for it.
        if (subscriber.queue.length > 0 && subscriber.lastPullAt < cutoff) subscriber.release();
      }
    }, sweepIntervalMs);
    // The rejection is delivered to whoever awaits acquire(); without a
    // handler here Bun would also report it as unhandled.
    ready.catch(() => {});
    let codec: string | null = null;
    let readyResolved = false;
    const deadline = setTimeout(() => {
      if (!readyResolved) {
        rejectReady(
          new TileEncoderError("tile-encoder-timeout", `no init segment within ${INIT_DEADLINE_MS}ms`),
        );
        drop(key, entry);
      }
    }, INIT_DEADLINE_MS);
    // The pump. Runs for the encoder's whole life; the entry's readiness is
    // just its first milestone.
    void (async () => {
      try {
        for await (const frame of process.frames) {
          if (entry.ended) break;
          if (frame.kind === KIND_META) {
            const meta = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
            if (meta.type === "error") {
              throw new TileEncoderError("tile-encoder-failed", String(meta.message));
            }
            if (meta.type === "codec" && typeof meta.codec === "string") codec = meta.codec;
          } else if (frame.kind === KIND_INIT && !readyResolved) {
            if (!codec) throw new TileEncoderError("tile-encoder-failed", "init segment before codec");
            readyResolved = true;
            resolveReady({ codec, init: frame.payload });
          } else if (frame.kind === KIND_MEDIA) {
            for (const subscriber of entry.subscribers) {
              subscriber.queue.push(frame.payload);
              if (subscriber.queue.length > SUBSCRIBER_QUEUE_LIMIT) subscriber.queue.shift();
              subscriber.notify?.();
            }
          }
        }
        if (!readyResolved) {
          const detail = await process.failureDetail();
          throw new TileEncoderError(
            "tile-encoder-failed",
            detail.trim() || "encoder exited before producing video",
          );
        }
      } catch (error) {
        if (!readyResolved) {
          readyResolved = true;
          rejectReady(
            error instanceof TileEncoderError
              ? error
              : new TileEncoderError("tile-encoder-failed", (error as Error).message),
          );
        }
      } finally {
        clearTimeout(deadline);
        drop(key, entry);
      }
    })();
    entries.set(key, entry);
    return entry;
  }

  async function acquire(key: string): Promise<TileSubscription> {
    let entry = entries.get(key);
    if (!entry || entry.ended) entry = start(key);
    const { codec, init } = await entry.ready;
    if (entry.ended) throw new TileEncoderError("tile-encoder-failed", "encoder ended during subscribe");
    if (entry.linger) {
      clearTimeout(entry.linger);
      entry.linger = null;
    }
    const subscriber: Subscriber = {
      queue: [],
      notify: null,
      ended: false,
      lastPullAt: Date.now(),
      release: () => {},
    };
    entry.subscribers.add(subscriber);
    const held = entry;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      subscriber.ended = true;
      subscriber.notify?.();
      held.subscribers.delete(subscriber);
      if (held.subscribers.size === 0 && !held.ended && !held.linger) {
        held.linger = setTimeout(() => {
          if (held.subscribers.size === 0) drop(key, held);
        }, lingerMs);
      }
    };
    subscriber.release = release;
    async function* segments(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          subscriber.lastPullAt = Date.now();
          const next = subscriber.queue.shift();
          if (next) {
            yield next;
            continue;
          }
          if (subscriber.ended) return;
          await new Promise<void>((resolve) => {
            subscriber.notify = resolve;
          });
          subscriber.notify = null;
        }
      } finally {
        release();
      }
    }
    return { codec, init, segments: segments(), release };
  }

  return {
    acquire,
    /** Live entry count, for tests. */
    size: () => entries.size,
  };
}
