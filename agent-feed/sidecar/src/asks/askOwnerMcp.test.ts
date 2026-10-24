import { expect, test } from "bun:test";
import type { WaitAskOwnerCommand } from "@agentdesk/agent-feed-wire";
import { answeredText, waitForVerdict, type AskOwnerDependencies } from "@/asks/askOwnerMcp";

const COMMAND: WaitAskOwnerCommand = {
  toolUseId: "toolu_01",
  source: "claude",
  sessionId: "2adc3708-fadb-4e2f-a744-322df224faf4",
  questions: [{ id: "name", question: "What should it be called?", kind: "text", options: [] }],
};

const stream = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });

/** A sidecar that answers each attempt from a script, and the waits taken between attempts. */
function scripted(answers: Array<(signal: AbortSignal) => Promise<Response>>) {
  const pauses: number[] = [];
  let attempts = 0;
  const deps: AskOwnerDependencies = {
    session: () => ({ source: "claude", sessionId: COMMAND.sessionId }),
    post: (_command, signal) => {
      const next = answers[Math.min(attempts, answers.length - 1)]!;
      attempts += 1;
      return next(signal);
    },
    pause: async (ms) => {
      pauses.push(ms);
    },
  };
  return { deps, pauses, attempts: () => attempts };
}

test("asks again, waiting longer each time, until a connection carries the verdict", async () => {
  const answered = { answered: [{ id: "name", chosen: [], text: "Ledger" }] };
  const sidecar = scripted([
    async () => {
      throw new Error("connection refused");
    },
    async () => new Response("restarting", { status: 503 }),
    // Answers and hangs up without a verdict, as a sidecar does when it restarts mid-wait.
    async () => stream(": ping\n\n"),
    async () => stream(`: ping\n\ndata: ${JSON.stringify(answered)}\n\n`),
  ]);
  const outcome = await waitForVerdict(COMMAND, sidecar.deps, new AbortController().signal);
  expect(outcome).toEqual(answered);
  expect(sidecar.attempts()).toBe(4);
  expect(sidecar.pauses).toEqual([1_000, 2_000, 5_000]);
});

test("never asks faster than every 30 seconds however long the sidecar keeps hanging up", async () => {
  const sidecar = scripted([async () => stream("")]);
  const stop = new AbortController();
  sidecar.deps.pause = async (ms) => {
    sidecar.pauses.push(ms);
    if (sidecar.pauses.length === 8) stop.abort();
  };
  expect(await waitForVerdict(COMMAND, sidecar.deps, stop.signal)).toEqual({ cancelled: true });
  expect(sidecar.pauses).toEqual([1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000, 30_000]);
});

test("comes back at once only when the sidecar refuses the questions themselves", async () => {
  const sidecar = scripted([
    async () =>
      Response.json({ error: { code: "ask-invalid", message: "two questions share one id" } }, { status: 400 }),
  ]);
  expect(await waitForVerdict(COMMAND, sidecar.deps, new AbortController().signal)).toEqual({
    refused: "two questions share one id",
  });
  expect(sidecar.attempts()).toBe(1);
  expect(sidecar.pauses).toEqual([]);
});

test("lets the call go when Claude cancels it, mid-wait", async () => {
  const cancel = new AbortController();
  const sidecar = scripted([
    (signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
        cancel.abort();
      }),
  ]);
  expect(await waitForVerdict(COMMAND, sidecar.deps, cancel.signal)).toEqual({ cancelled: true });
  expect(sidecar.attempts()).toBe(1);
});

test("redoes a wait that goes silent, and keeps going on the next", async () => {
  const dismissed = { dismissed: true } as const;
  const sidecar = scripted([
    // Never answers and never ends: only the stall watchdog moves this on.
    (signal) =>
      new Promise<Response>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stalled")))),
    async () => stream(`data: ${JSON.stringify(dismissed)}\n\n`),
  ]);
  expect(await waitForVerdict(COMMAND, sidecar.deps, new AbortController().signal, 5)).toEqual(dismissed);
  expect(sidecar.attempts()).toBe(2);
});

test("tells the model each answer under its question", () => {
  const questions = [
    {
      id: "auth",
      question: "Which auth method?",
      kind: "single" as const,
      options: [{ label: "OAuth" }, { label: "SSO" }],
    },
    { id: "name", question: "What should it be called?", kind: "text" as const, options: [] },
  ];
  expect(
    answeredText(questions, [
      { id: "auth", chosen: [{ label: "OAuth", note: "we use Google" }] },
      { id: "name", chosen: [], text: "Ledger" },
    ]),
  ).toBe(
    [
      "The owner answered:",
      "- auth: Which auth method?",
      '  - chose "OAuth", with the note: we use Google',
      "- name: What should it be called?",
      "  - in their own words: Ledger",
    ].join("\n"),
  );
});

test("tells the model to stop after three refusals in a row, and answers a real call through MCP", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createAskOwnerMcpServer } = await import("@/asks/askOwnerMcp");
  let refuse = true;
  const server = createAskOwnerMcpServer({
    session: () => ({ source: "claude", sessionId: COMMAND.sessionId }),
    post: async () =>
      refuse
        ? Response.json({ error: { code: "ask-invalid", message: "two questions share one id" } }, { status: 400 })
        : stream(`data: ${JSON.stringify({ answered: [{ id: "name", chosen: [], text: "Ledger" }] })}\n\n`),
    pause: async () => {},
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const ask = async (id: string) => {
    const result = await client.callTool({
      name: "ask_owner",
      arguments: { questions: COMMAND.questions },
      _meta: { "claudecode/toolUseId": id },
    });
    return (result.content as { text: string }[])[0]!.text;
  };
  expect(await ask("toolu_1")).toContain("Correct them before asking again");
  expect(await ask("toolu_2")).toContain("Correct them before asking again");
  expect(await ask("toolu_3")).toContain("stop calling ask_owner");
  refuse = false;
  expect(await ask("toolu_4")).toContain("in their own words: Ledger");
  await client.close();
});
