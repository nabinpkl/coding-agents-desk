// Two families, and the same rule for both: a serve event that already carries the words is
// delivered, and a re-read is bought only by the one event that means the serve has finished
// writing. A compaction has no durable message to read while it streams, so only its end
// schedules one. A turn's prose and thinking are published as they are written, so those go to
// the projection and must never each cost a round trip -- that read is what made the text arrive
// in steps, re-mapping 200 messages to move one line of it. And a serve that asks -- a
// permission, a form -- is answered through the session's broker, and the answer is its reply.
import { expect, test } from "bun:test";
import type { V2Event } from "@opencode/client";
import type { OpencodeClient } from "@/agents/opencode/serve/opencodeClient";
import type { AgentUiBroker } from "@/agents/agentUiBroker";
import { OpencodeServeEvents, type ServeEventRouter } from "@/agents/opencode/serve/opencodeServeEvents";

function compaction(type: string, data: Record<string, unknown>): V2Event {
  return { id: "evt-1", type, data } as unknown as V2Event;
}

function part(type: string, data: Record<string, unknown>): V2Event {
  return { id: "evt-1", type, data } as unknown as V2Event;
}

/** A broker that answers every request from a script, in order, recording what it was asked. */
function scriptedBroker(answers: unknown[], asked: unknown[]): AgentUiBroker {
  return {
    request: async (request: unknown) => {
      asked.push(request);
      return answers.shift();
    },
  } as unknown as AgentUiBroker;
}

function harness(events: V2Event[], ui: AgentUiBroker | null = null) {
  const calls: string[] = [];
  const replies: unknown[] = [];
  const router: ServeEventRouter = {
    refresh: (sessionId, full = false) => void calls.push(`refresh:${sessionId}${full ? ":full" : ""}`),
    setRunState: (sessionId, state) => void calls.push(`run:${sessionId}:${state}`),
    catalogChanged: () => void calls.push("catalog"),
    hasSession: () => true,
    uiFor: () => ui,
    compactionStarted: (sessionId, messageId) => void calls.push(`started:${sessionId}:${messageId}`),
    compactionDeltaForSession: (sessionId, text) => void calls.push(`sessdelta:${sessionId}:${text}`),
    compactionSettled: (sessionId) => void calls.push(`settled:${sessionId}`),
    streamPart: (sessionId, streamed) =>
      void calls.push(`part:${sessionId}:${streamed.kind}:${streamed.phase}:${streamed.messageId}:${streamed.chunk ?? ""}`),
  };
  const client = {
    event: {
      subscribe: ({ signal }: { signal?: AbortSignal } = {}) => (async function* () {
        for (const event of events) yield event;
        // Hold the stream open the way the real one does; abort ends it.
        await new Promise<void>((_, reject) => {
          if (signal?.aborted) reject(new Error("aborted"));
          else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      })(),
    },
    permission: { reply: async (input: unknown) => void replies.push({ permission: input }) },
    session: { form: { reply: async (input: unknown) => void replies.push({ form: input }) } },
  } as unknown as OpencodeClient;
  const stream = new OpencodeServeEvents(router, () => client);
  return { calls, replies, stream };
}

test("compaction streams by session and refreshes only when it lands", async () => {
  // Deltas name only the session, so they must never each cost a re-read -- there is nothing
  // durable to read until the checkpoint lands.
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

test("a compaction failure settles the notice and refreshes", async () => {
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("a permission the serve asks is asked of the reader, and the answer is its decision", async () => {
  const asked: unknown[] = [];
  const { replies, stream } = harness([
    part("permission.asked", { id: "per-1", sessionID: "ses-1", action: "bash", resources: ["rm -rf build"] }),
  ], scriptedBroker(["always"], asked));
  stream.setWanted(true);
  await settle();
  await stream.dispose();
  expect(asked).toEqual([
    { kind: "select", title: "Allow bash?", message: "rm -rf build", options: ["once", "always", "reject"], key: "permission:per-1" },
  ]);
  expect(replies).toEqual([{ permission: { sessionID: "ses-1", requestID: "per-1", decision: "always" } }]);
});

test("a reader who never answers a permission rejects it rather than leaving the turn hanging", async () => {
  const { replies, stream } = harness([
    part("permission.asked", { id: "per-2", sessionID: "ses-1", action: "edit", resources: ["/a"] }),
  ], scriptedBroker([undefined], []));
  stream.setWanted(true);
  await settle();
  await stream.dispose();
  expect(replies).toEqual([{ permission: { sessionID: "ses-1", requestID: "per-2", decision: "reject" } }]);
});

test("a form asks each field the closest way the broker can, and replies with the answers by key", async () => {
  const asked: unknown[] = [];
  const form = {
    id: "form-1",
    sessionID: "ses-1",
    title: "Before I start",
    fields: [
      { key: "target", type: "string", title: "Which target?", options: [{ value: "web", label: "Web" }, { value: "ios", label: "iOS" }] },
      { key: "tests", type: "boolean", title: "Run the tests?" },
      { key: "note", type: "string", title: "Anything else?" },
      { key: "retries", type: "integer", title: "Retries" },
      { key: "docs", type: "external", url: "https://example.com", title: "Read this" },
    ],
  };
  const { replies, stream } = harness([part("form.created", { form })], scriptedBroker(["iOS", true, "be quick", "3.7"], asked));
  stream.setWanted(true);
  await settle();
  await stream.dispose();
  expect(asked.map((one) => (one as { kind: string }).kind)).toEqual(["select", "confirm", "input", "input"]);
  expect(replies).toEqual([
    { form: { sessionID: "ses-1", formID: "form-1", answer: { target: "ios", tests: true, note: "be quick", retries: 3 } } },
  ]);
});

test("a failed turn marks the session errored, and a rename refreshes the catalog", async () => {
  const { calls, stream } = harness([
    part("session.execution.failed", { sessionID: "ses-1", error: { type: "provider.quota", message: "limit" } }),
    part("session.renamed", { sessionID: "ses-1", title: "New name" }),
  ]);
  stream.setWanted(true);
  await settle();
  await stream.dispose();
  expect(calls).toEqual(["run:ses-1:error", "refresh:ses-1", "catalog"]);
});
