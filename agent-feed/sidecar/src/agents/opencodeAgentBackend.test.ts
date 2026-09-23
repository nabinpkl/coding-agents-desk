import { expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { OpencodeAgentBackend } from "@/agents/opencodeAgentBackend";
import {
  AgentModeUnsupportedError,
  AgentSessionNotFoundError,
} from "@/agents/agentBackend";

interface Recorded {
  prompts: Array<{ sessionID: string; text: string; delivery: string }>;
  interrupts: string[];
  permissionReplies: Array<{ requestID: string; reply: string }>;
  created: string[];
}

function userItem(id: string, text: string) {
  return { id, time: { created: 100 }, text, type: "user" as const };
}

function sessionInfo() {
  return {
    id: "s1",
    projectID: "p",
    cost: 0,
    tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } },
    time: { created: 1, updated: 2 },
    title: "One",
    location: { directory: "/repo" },
    model: { id: "m", providerID: "p" },
  };
}

function fakeServe(recorded: Recorded, messages: Array<{ id: string; time: { created: number }; text: string; type: "user" }>) {
  return {
    v2: {
      session: {
        messages: async () => ({ data: { data: messages, cursor: {} } }),
        get: async () => ({ data: { data: sessionInfo() } }),
        prompt: async (params: { sessionID: string; prompt?: { text: string }; delivery?: string }) => {
          recorded.prompts.push({
            sessionID: params.sessionID,
            text: params.prompt?.text ?? "",
            delivery: params.delivery ?? "",
          });
          return { data: {} };
        },
        interrupt: async (params: { sessionID: string }) => {
          recorded.interrupts.push(params.sessionID);
          return { data: true };
        },
        create: async (params: { location?: { directory?: string } }) => {
          recorded.created.push(params.location?.directory ?? "");
          return { data: { data: { id: "s-new", title: "New" } } };
        },
        permission: {
          reply: async (params: { requestID: string; reply: string }) => {
            recorded.permissionReplies.push({ requestID: params.requestID, reply: params.reply });
            return { data: true };
          },
        },
        question: { reply: async () => ({ data: true }) },
      },
      event: {
        subscribe: async (options?: { signal?: AbortSignal }) => ({
          stream: (async function* () {
            const next = await new Promise<unknown>((resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
              pushToStream = resolve;
            });
            yield next;
          })(),
        }),
      },
    },
  };
}

// Set by the fake stream generator on each subscribe; the test pushes one event.
let pushToStream: ((value: unknown) => void) | null = null;

function fixture() {
  pushToStream = null;
  const recorded: Recorded = { prompts: [], interrupts: [], permissionReplies: [], created: [] };
  const backend = new OpencodeAgentBackend({
    resolveSession: (sessionId) =>
      sessionId === "s1" ? { sessionId, projectPath: "/repo" } : undefined,
    onSessionCreated() {},
    onCatalogChanged() {},
    client: () => fakeServe(recorded, [userItem("msg-u", "hello")]) as unknown as OpencodeClient,
    now: () => 1000,
  });
  return { backend, recorded };
}

test("timeline serves nice mode only", async () => {
  const { backend } = fixture();
  const page = await backend.page("s1", 0, 10, "nice");
  expect(page).toMatchObject({ mode: "nice", total: 1 });
  expect(backend.sessionUsage("s1")).toEqual(expect.objectContaining({ model: "p/m", limit: null }));
  await expect(backend.page("s1", 0, 10, "raw")).rejects.toBeInstanceOf(AgentModeUnsupportedError);
  await expect(backend.page("nope", 0, 10, "nice")).rejects.toBeInstanceOf(AgentSessionNotFoundError);
  await backend.dispose();
});

test("send prompts the serve and repeats the receipt for a repeated request", async () => {
  const { backend, recorded } = fixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { text?: string; delivery?: string };
    recorded.prompts.push({ sessionID: String(url).split("/").at(-2) ?? "", text: body.text ?? "", delivery: body.delivery ?? "" });
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  try {
    const first = await backend.send("s1", "r1", "go", "next");
    const second = await backend.send("s1", "r1", "go", "next");
    expect(first).toEqual(second);
    expect(recorded.prompts).toEqual([{ sessionID: "s1", text: "go", delivery: "queue" }]);
    const steered = await backend.send("s1", "r2", "turn", "steer");
    expect(steered).toEqual({ requestId: "r2", delivery: "steer" });
    expect(recorded.prompts[1]).toEqual({ sessionID: "s1", text: "turn", delivery: "steer" });
  } finally {
    globalThis.fetch = realFetch;
  }
  const receipt = await backend.abort("s1", "r3");
  expect(receipt).toEqual({ requestId: "r3", delivery: "abort" });
  expect(recorded.interrupts).toEqual(["s1"]);
  await backend.dispose();
});

test("a serve permission becomes a broker select and the answer becomes its reply", async () => {
  const { backend, recorded } = fixture();
  const seen: Array<{ type: string; request?: { requestId: string; kind: string; options?: string[] } }> = [];
  const offUi = await backend.subscribeUi("s1", (event) => {
    if (event.type === "request") {
      seen.push({ type: "request", request: { requestId: event.request.requestId, kind: event.request.kind, options: event.request.options } });
    }
  });
  const offTimeline = await backend.subscribe("s1", 0, () => {});
  // Let the stream loop reach the fake subscribe before pushing through it.
  for (let i = 0; i < 100 && pushToStream === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  pushToStream?.({
    id: "ev-1",
    type: "permission.v2.asked",
    data: { id: "perm-1", sessionID: "s1", action: "shell", resources: ["rm *"] },
  });
  for (let i = 0; i < 100 && seen.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(seen).toHaveLength(1);
  expect(seen[0]?.request?.options).toEqual(["once", "always", "reject"]);
  expect(await backend.respondToUi("s1", seen[0]!.request!.requestId, "once")).toBe("accepted");
  for (let i = 0; i < 100 && recorded.permissionReplies.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(recorded.permissionReplies).toEqual([{ requestID: "perm-1", reply: "once" }]);
  offUi();
  offTimeline();
  await backend.dispose();
});

test("creating a session registers it through the serve", async () => {  const created: Array<{ sessionId: string; projectPath: string }> = [];
  const recorded: Recorded = { prompts: [], interrupts: [], permissionReplies: [], created: [] };
  const backend = new OpencodeAgentBackend({
    resolveSession: () => undefined,
    onSessionCreated: (location) => created.push(location),
    onCatalogChanged() {},
    client: () => fakeServe(recorded, [userItem("msg-u", "hello")]) as unknown as OpencodeClient,
    now: () => 1000,
  });
  const descriptor = await backend.createSession("r1", "/repo");
  expect(descriptor).toMatchObject({ sessionId: "s-new", source: "opencode", projectPath: "/repo" });
  expect(created).toEqual([{ sessionId: "s-new", projectPath: "/repo" }]);
  expect(recorded.created).toEqual(["/repo"]);
  await backend.dispose();
});

test("opening a stale projection re-reads the serve", async () => {
  let now = 1000;
  const recorded: Recorded = { prompts: [], interrupts: [], permissionReplies: [], created: [] };
  const messages = [userItem("msg-u", "hello")];
  const backend = new OpencodeAgentBackend({
    resolveSession: (sessionId) => sessionId === "s1" ? { sessionId, projectPath: "/repo" } : undefined,
    onSessionCreated() {},
    onCatalogChanged() {},
    client: () => fakeServe(recorded, messages) as unknown as OpencodeClient,
    now: () => now,
  });
  const first = await backend.page("s1", 0, 10, "nice");
  expect(first.total).toBe(1);
  // Inside the bound the open path serves memory without another round trip.
  now += 5_000;
  const second = await backend.page("s1", 0, 10, "nice");
  expect(second.sequence).toBe(first.sequence);
  // Past the bound a new row on the serve is picked up on open.
  messages.push(userItem("msg-u2", "again"));
  now += 11_000;
  const third = await backend.page("s1", 0, 10, "nice");
  expect(third.total).toBe(2);
  await backend.dispose();
});
