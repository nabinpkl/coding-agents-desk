// The serve's compaction family lands in the watch, not in a re-read: while a compaction
// streams there is no durable message to read, so only `ended` (and the checkpoint landing)
// schedules one. Deltas arrive per token and must never each cost a round trip.
import { expect, test } from "bun:test";
import type { OpencodeClient, V2Event } from "@opencode-ai/sdk/v2/client";
import { OpencodeServeEvents, type ServeEventRouter } from "@/agents/opencode/opencodeServeEvents";

function compaction(type: string, data: Record<string, unknown>): V2Event {
  return { id: "evt-1", type, data } as unknown as V2Event;
}

function harness(events: V2Event[]) {
  const calls: string[] = [];
  const router: ServeEventRouter = {
    refresh: (sessionId) => void calls.push(`refresh:${sessionId}`),
    setRunState: (sessionId, state) => void calls.push(`run:${sessionId}:${state}`),
    catalogChanged: () => void calls.push("catalog"),
    hasSession: () => true,
    uiFor: () => null,
    compactionStarted: (sessionId, messageId) => void calls.push(`started:${sessionId}:${messageId}`),
    compactionDelta: (sessionId, messageId, text) => void calls.push(`delta:${sessionId}:${messageId}:${text}`),
    compactionDeltaForSession: (sessionId, text) => void calls.push(`sessdelta:${sessionId}:${text}`),
    compactionEnded: (sessionId, messageId) => void calls.push(`ended:${sessionId}:${messageId}`),
    compactionSettled: (sessionId) => void calls.push(`settled:${sessionId}`),
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
    "refresh:ses-1",
  ]);
});

test("a landed checkpoint settles the notice and refreshes", async () => {
  const { calls, stream } = harness([
    compaction("session.compacted", { sessionID: "ses-9" }),
  ]);
  stream.setWanted(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await stream.dispose();
  expect(calls).toEqual(["settled:ses-9", "refresh:ses-9"]);
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
    "refresh:ses-1",
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
