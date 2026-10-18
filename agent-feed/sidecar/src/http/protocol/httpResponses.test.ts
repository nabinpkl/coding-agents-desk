import { expect, test } from "bun:test";
import { encodeServerSentEvent, startServerSentEventStream } from "@/http/protocol/httpResponses";

const server = { timeout() {} } as never;

/** Reads what a stream writes for `ms`, then leaves it. */
async function readFor(response: Response, ms: number): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([reader.read(), Bun.sleep(Math.max(0, deadline - Date.now())).then(() => null)]);
    if (next === null || next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  await reader.cancel();
  return text;
}

test("a stream that asks for a heartbeat message beats with it rather than a comment", async () => {
  // A comment is invisible to `EventSource`, so a reader timing silence needs the beat to be a
  // message it actually receives.
  const bytes = encodeServerSentEvent({ type: "heartbeat" });
  const response = startServerSentEventStream(new Request("http://localhost/stream"), server, () => () => {}, {
    heartbeat: { bytes, intervalMs: 20 },
  });

  const text = await readFor(response, 70);

  expect(text).toContain('data: {"type":"heartbeat"}\n\n');
  expect(text).not.toContain(": ping");
});

test("a stream that asks for nothing still beats with a comment", async () => {
  // The default is untouched: every other stream's readers parse `data:` as their own messages,
  // and a heartbeat message they do not know would reach them as one.
  const response = startServerSentEventStream(new Request("http://localhost/stream"), server, () => () => {});
  const reader = response.body!.getReader();
  // Nothing is written before the first beat, and the default beat is 20s away.
  const first = await Promise.race([reader.read(), Bun.sleep(30).then(() => null)]);
  await reader.cancel();

  expect(first).toBeNull();
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
