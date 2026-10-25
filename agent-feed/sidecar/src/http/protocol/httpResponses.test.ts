import { afterEach, expect, jest, test } from "bun:test";
import { encodeServerSentEvent, SSE_HEARTBEAT_MS, startServerSentEventStream } from "@/http/protocol/httpResponses";
import { drained } from "@/testing/until";

const server = { timeout() {} } as never;

// The beat is a timer, so these run on fake time and move the clock to it rather than waiting.
afterEach(() => {
  jest.useRealTimers();
});

/**
 * Asks what the stream has written since the last ask, or null when it has written nothing. A chunk
 * already queued is read within the promise turns `drained` waits out, so losing that race means
 * there is none -- and the read that lost is kept for the next ask rather than left to take its chunk.
 */
function writes(response: Response): { next(): Promise<string | null>; leave(): Promise<void> } {
  const reader = response.body!.getReader();
  let pending: ReturnType<typeof reader.read> | null = null;
  return {
    async next() {
      pending ??= reader.read();
      const read = await Promise.race([pending, drained().then(() => null)]);
      if (read === null) return null;
      pending = null;
      return read.done ? null : new TextDecoder().decode(read.value);
    },
    leave: () => reader.cancel(),
  };
}

test("a stream that asks for a heartbeat message beats with it rather than a comment", async () => {
  // A comment is invisible to `EventSource`, so a reader timing silence needs the beat to be a
  // message it actually receives.
  jest.useFakeTimers();
  const bytes = encodeServerSentEvent({ type: "heartbeat" });
  const response = startServerSentEventStream(new Request("http://localhost/stream"), server, () => () => {}, {
    heartbeat: { bytes, intervalMs: 20 },
  });
  const stream = writes(response);

  jest.advanceTimersByTime(20);
  const text = await stream.next();
  await stream.leave();

  expect(text).toBe('data: {"type":"heartbeat"}\n\n');
});

test("a stream that asks for nothing still beats with a comment", async () => {
  // The default is untouched: every other stream's readers parse `data:` as their own messages,
  // and a heartbeat message they do not know would reach them as one.
  jest.useFakeTimers();
  const response = startServerSentEventStream(new Request("http://localhost/stream"), server, () => () => {});
  const stream = writes(response);
  // Nothing is written before the first beat, and the default beat is a while away.
  jest.advanceTimersByTime(SSE_HEARTBEAT_MS - 1);
  expect(await stream.next()).toBeNull();

  jest.advanceTimersByTime(1);
  expect(await stream.next()).toBe(": ping\n\n");
  await stream.leave();
});

test("a reader that leaves releases what the stream subscribed to, exactly once", async () => {
  // The cleanup `onStart` returns is the only thing standing between a closed tab and a listener
  // that keeps writing into nothing, so leaving must reach it -- whether the reader cancels or the
  // request is aborted under it.
  let released = 0;
  const response = startServerSentEventStream(new Request("http://localhost/stream"), server, () => () => {
    released += 1;
  });
  await response.body!.getReader().cancel();
  expect(released).toBe(1);

  const abort = new AbortController();
  let releasedOnAbort = 0;
  startServerSentEventStream(new Request("http://localhost/stream", { signal: abort.signal }), server, () => () => {
    releasedOnAbort += 1;
  });
  abort.abort();
  abort.abort();
  expect(releasedOnAbort).toBe(1);
});
