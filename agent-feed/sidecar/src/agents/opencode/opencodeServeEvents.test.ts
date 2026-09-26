// Two families, and the same rule for both: a serve event that already carries the words is
// delivered, and a re-read is bought only by the one event that means the serve has finished
// writing. A compaction has no durable message to read while it streams, so only `ended` (and
// the checkpoint landing) schedules one. A turn's prose and thinking are published as they are
// written, so those go to the projection and must never each cost a round trip -- that read is
// what made the text arrive in steps, re-mapping 200 messages to move one line of it.
import { expect, test } from "bun:test";
import type { OpencodeClient, V2Event } from "@opencode-ai/sdk/v2/client";
import { OpencodeServeEvents, type ServeEventRouter } from "@/agents/opencode/opencodeServeEvents";

function compaction(type: string, data: Record<string, unknown>): V2Event {
  return { id: "evt-1", type, data } as unknown as V2Event;
}

function part(type: string, data: Record<string, unknown>): V2Event {
  return { id: "evt-1", type, data } as unknown as V2Event;
}

function harness(events: V2Event[]) {
  const calls: string[] = [];
  const router: ServeEventRouter = {
    refresh: (sessionId, full = false) => void calls.push(`refresh:${sessionId}${full ? ":full" : ""}`),
    setRunState: (sessionId, state) => void calls.push(`run:${sessionId}:${state}`),
    catalogChanged: () => void calls.push("catalog"),
    hasSession: () => true,
    uiFor: () => null,
    compactionStarted: (sessionId, messageId) => void calls.push(`started:${sessionId}:${messageId}`),
    compactionDelta: (sessionId, messageId, text) => void calls.push(`delta:${sessionId}:${messageId}:${text}`),
    compactionDeltaForSession: (sessionId, text) => void calls.push(`sessdelta:${sessionId}:${text}`),
    compactionEnded: (sessionId, messageId) => void calls.push(`ended:${sessionId}:${messageId}`),
    compactionSettled: (sessionId) => void calls.push(`settled:${sessionId}`),
    streamPart: (sessionId, streamed) =>
      void calls.push(`part:${sessionId}:${streamed.kind}:${streamed.phase}:${streamed.messageId}:${streamed.chunk ?? ""}`),
  };
  const client = {
    v2: {
      event: {
        subscribe: async ({ signal }: { signal?: AbortSignal }) => ({
          stream: (async function* () {
            for (const event of events) yield event;
            // Hold the stream open the way the real one does; abort ends it.
            await new Promise<void>((_, reject) => {
              if (signal?.aborted) reject(new Error("aborted"));
              else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          })(),
        }),
      },
    },
  } as unknown as OpencodeClient;
  const stream = new OpencodeServeEvents(router, () => client);
  return { calls, stream };
}

test("compaction streams into the watch and refreshes only when it lands", async () => {
  const { calls, stream } = harness([
    compaction("session.next.compaction.started", { sessionID: "ses-1", messageID: "msg-1", reason: "auto" }),
    compaction("session.next.compaction.delta", { sessionID: "ses-1", messageID: "msg-1", text: "## Sum" }),
    compaction("session.next.compaction.delta", { sessionID: "ses-1", messageID: "msg-1", text: "mary" }),
    compaction("session.next.compaction.ended", {
      sessionID: "ses-1",
      messageID: "msg-1",
      reason: "auto",
      text: "## Summary",
      recent: "recent",
    }),
  ]);
  stream.setWanted(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await stream.dispose();
  expect(calls).toEqual([
    "run:ses-1:running",
    "started:ses-1:msg-1",
    "delta:ses-1:msg-1:## Sum",
    "delta:ses-1:msg-1:mary",
    "ended:ses-1:msg-1",
    "refresh:ses-1:full",
  ]);
});

test("a landed checkpoint settles the notice and refreshes", async () => {
  const { calls, stream } = harness([
    compaction("session.compacted", { sessionID: "ses-9" }),
  ]);
  stream.setWanted(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await stream.dispose();
  expect(calls).toEqual(["settled:ses-9", "refresh:ses-9:full"]);
});

test("v2 compaction streams by session and refreshes only when it lands", async () => {
  // The live serve (v2.0.16) emits `session.compaction.*`, which the pinned v1 SDK union does
  // not name: the raw JSON still arrives over the same stream. Deltas name only the session,
  // so they must never each cost a re-read -- there is nothing durable to read until the
  // checkpoint lands.
  const { calls, stream } = harness([
    compaction("session.compaction.started", { sessionID: "ses-1", reason: "auto", recent: "r", inputID: "msg-1" }),
    compaction("session.compaction.delta", { sessionID: "ses-1", text: "## Sum" }),
    compaction("session.compaction.delta", { sessionID: "ses-1", text: "mary" }),
    compaction("session.compaction.ended", {
      sessionID: "ses-1",
      reason: "auto",
      text: "## Summary",
      recent: "recent",
    }),
  ]);
  stream.setWanted(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await stream.dispose();
  expect(calls).toEqual([
    "run:ses-1:running",
    "started:ses-1:msg-1",
    "sessdelta:ses-1:## Sum",
    "sessdelta:ses-1:mary",
    "settled:ses-1",
    "refresh:ses-1:full",
  ]);
});

test("v2 compaction failure settles the notice and refreshes", async () => {
  const { calls, stream } = harness([
    compaction("session.compaction.failed", {
      sessionID: "ses-2",
      reason: "auto",
      error: { type: "compaction.failed", message: "no summary" },
    }),
  ]);
  stream.setWanted(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await stream.dispose();
  expect(calls).toEqual(["settled:ses-2", "refresh:ses-2"]);
});

test("a turn's words go to the projection, and only the step ending buys a read", async () => {
  const { calls, stream } = harness([
    part("session.reasoning.started", { sessionID: "ses-1", assistantMessageID: "msg-1", ordinal: 0 }),
    part("session.reasoning.delta", { sessionID: "ses-1", assistantMessageID: "msg-1", ordinal: 0, delta: "weighing" }),
    part("session.reasoning.ended", { sessionID: "ses-1", assistantMessageID: "msg-1", ordinal: 0, text: "weighing it up" }),
    part("session.text.started", { sessionID: "ses-1", assistantMessageID: "msg-1", ordinal: 0 }),
    part("session.text.delta", { sessionID: "ses-1", assistantMessageID: "msg-1", ordinal: 0, delta: "the answer" }),
    part("session.text.ended", { sessionID: "ses-1", assistantMessageID: "msg-1", ordinal: 0, text: "the answer" }),
    part("session.step.ended", { sessionID: "ses-1", assistantMessageID: "msg-1", finish: "stop" }),
  ]);
  stream.setWanted(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await stream.dispose();
  expect(calls).toEqual([
    "part:ses-1:reasoning:started:msg-1:",
    "part:ses-1:reasoning:delta:msg-1:weighing",
    "part:ses-1:reasoning:ended:msg-1:",
    "part:ses-1:text:started:msg-1:",
    "part:ses-1:text:delta:msg-1:the answer",
    "part:ses-1:text:ended:msg-1:",
    "refresh:ses-1",
  ]);
});

test("a tool lifecycle is not a word, so it leaves to the read that has the whole call", async () => {
  const { calls, stream } = harness([
    part("session.tool.input.started", { sessionID: "ses-1", assistantMessageID: "msg-1", id: "call-1", name: "read" }),
    part("session.tool.input.ended", { sessionID: "ses-1", assistantMessageID: "msg-1", id: "call-1" }),
    part("session.tool.called", { sessionID: "ses-1", assistantMessageID: "msg-1", id: "call-1", name: "read" }),
    part("session.tool.success", { sessionID: "ses-1", assistantMessageID: "msg-1", id: "call-1" }),
  ]);
  stream.setWanted(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await stream.dispose();
  // A partial tool row is a call with no result under it; the read that ends the step brings
  // the input, the output and the state together. These four do coalesce into one read.
  expect(calls).toEqual([
    "refresh:ses-1",
    "refresh:ses-1",
    "refresh:ses-1",
    "refresh:ses-1",
  ]);
});

test("a word event this shape cannot draw is dropped rather than read", async () => {
  const { calls, stream } = harness([
    part("session.text.delta", { assistantMessageID: "msg-1", ordinal: 0, delta: "no session" }),
    part("session.text.delta", { sessionID: "ses-1", ordinal: 0, delta: "no message id" }),
    part("session.text.delta", { sessionID: "ses-1", assistantMessageID: "msg-1", delta: "no ordinal" }),
    part("session.text.streamed", { sessionID: "ses-1", assistantMessageID: "msg-1", ordinal: 0, delta: "x" }),
  ]);
  stream.setWanted(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await stream.dispose();
  // Falling through to a read here would buy the same words one coalesced page re-read later,
  // which is the cost this family was moved off.
  expect(calls).toEqual([]);
});
