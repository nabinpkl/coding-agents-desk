import { afterEach, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { OpencodeAgentBackend } from "@/agents/opencodeAgentBackend";
import {
  AgentModeUnsupportedError,
  AgentSessionNotFoundError,
} from "@/agents/agentBackend";

interface Recorded {
  prompts: Array<{ sessionID: string; text: string; delivery: string; files?: Array<{ uri: string; mime: string; name: string }> }>;
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

function fakeServe(recorded: Recorded) {
  return {
    v2: {
      session: {
        get: async () => ({ data: { data: sessionInfo() } }),
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

type FakeItem = { id: string; time: { created: number }; text: string; type: "user" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Serves history pages and prompt receipts the way the serve does, so the
 * backend's raw fetch paths run for real in tests. `items` is newest-first;
 * the fake cursor is the last id of the page, which the backend passes back
 * opaquely exactly like the serve's token.
 */
function installFetch(recorded: Recorded, items: FakeItem[]): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/prompt")) {
      const body = JSON.parse(String(init?.body)) as { text?: string; delivery?: string; files?: Array<{ uri: string; mime: string; name: string }> };
      recorded.prompts.push({
        sessionID: parsed.pathname.split("/").at(-2) ?? "",
        text: body.text ?? "",
        delivery: body.delivery ?? "",
        ...(body.files ? { files: body.files } : {}),
      });
      return Response.json({ data: {} });
    }
    if (parsed.pathname.endsWith("/message")) {
      // The order rides the cursor, never the follow-up request -- the same
      // contract the serve's opaque token keeps (`order`+`direction` inside).
      // The fake cursor is `order:id` for readability; the backend passes it
      // back opaquely either way.
      const limit = Number(parsed.searchParams.get("limit") ?? 100);
      const cursor = parsed.searchParams.get("cursor");
      const cursorOrder = cursor?.split(":")[0];
      const cursorId = cursor?.split(":").slice(1).join(":");
      const order = cursorOrder ?? parsed.searchParams.get("order") ?? "desc";
      const ordered = order === "asc" ? [...items].reverse() : items;
      const at = cursorId ? ordered.findIndex((item) => item.id === cursorId) : -1;
      const start = cursorId && at < 0 ? ordered.length : at + 1;
      const page = ordered.slice(start, start + limit);
      const rest = ordered.length - (start + page.length);
      return Response.json({
        data: page,
        cursor: rest > 0 && page.length > 0 ? { next: `${order}:${page.at(-1)?.id}` } : {},
      });
    }
    return realFetch(url, init);
  }) as typeof fetch;
}

// Set by the fake stream generator on each subscribe; the test pushes one event.
let pushToStream: ((value: unknown) => void) | null = null;

function fixture() {
  pushToStream = null;
  const recorded: Recorded = { prompts: [], interrupts: [], permissionReplies: [], created: [] };
  installFetch(recorded, [userItem("msg-u", "hello")]);
  const backend = new OpencodeAgentBackend({
    resolveSession: (sessionId) =>
      sessionId === "s1" ? { sessionId, projectPath: "/repo" } : undefined,
    onSessionCreated() {},
    onCatalogChanged() {},
    client: () => fakeServe(recorded) as unknown as OpencodeClient,
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
  const first = await backend.send("s1", "r1", "go", "next");
  const second = await backend.send("s1", "r1", "go", "next");
  expect(first).toEqual(second);
  expect(recorded.prompts).toEqual([{ sessionID: "s1", text: "go", delivery: "queue" }]);
  const steered = await backend.send("s1", "r2", "turn", "steer");
  expect(steered).toEqual({ requestId: "r2", delivery: "steer" });
  expect(recorded.prompts[1]).toEqual({ sessionID: "s1", text: "turn", delivery: "steer" });
  const receipt = await backend.abort("s1", "r3");
  expect(receipt).toEqual({ requestId: "r3", delivery: "abort" });
  expect(recorded.interrupts).toEqual(["s1"]);
  await backend.dispose();
});

test("send stages image attachments as files the serve reads", async () => {
  const { backend, recorded } = fixture();
  const bytes = Buffer.from("fake-png-bytes").toString("base64");
  const receipt = await backend.send("s1", "r-img", "look", "next", [
    { data: bytes, mime: "image/png", name: "shot.png" },
  ]);
  expect(receipt).toEqual({ requestId: "r-img", delivery: "immediate" });
  const prompt = recorded.prompts.at(-1)!;
  expect(prompt.files).toHaveLength(1);
  expect(prompt.files![0]).toMatchObject({ mime: "image/png", name: "shot.png" });
  const uri = prompt.files![0]!.uri;
  expect(uri.startsWith("file://")).toBe(true);
  // The staged file holds the decoded bytes: the serve reads the path, not the route body.
  const staged = await Bun.file(uri.slice("file://".length)).arrayBuffer();
  expect(Buffer.from(staged).toString()).toBe("fake-png-bytes");
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

test("creating a session registers it through the serve", async () => {
  const created: Array<{ sessionId: string; projectPath: string }> = [];
  const recorded: Recorded = { prompts: [], interrupts: [], permissionReplies: [], created: [] };
  const backend = new OpencodeAgentBackend({
    resolveSession: () => undefined,
    onSessionCreated: (location) => created.push(location),
    onCatalogChanged() {},
    client: () => fakeServe(recorded) as unknown as OpencodeClient,
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
  // Newest-first, the way the serve lists; the tail read picks up the push.
  const messages = [userItem("msg-u", "hello")];
  installFetch(recorded, messages);
  const backend = new OpencodeAgentBackend({
    resolveSession: (sessionId) => sessionId === "s1" ? { sessionId, projectPath: "/repo" } : undefined,
    onSessionCreated() {},
    onCatalogChanged() {},
    client: () => fakeServe(recorded) as unknown as OpencodeClient,
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

test("a long history walks every page and lands chronological", async () => {
  const recorded: Recorded = { prompts: [], interrupts: [], permissionReplies: [], created: [] };
  // Newest-first, the way the serve lists: msg-249 first, msg-0 last.
  const all = Array.from({ length: 250 }, (_, i) => ({
    id: `msg-${249 - i}`,
    time: { created: (249 - i) * 10 },
    text: `say ${249 - i}`,
    type: "user" as const,
  }));
  const backend = new OpencodeAgentBackend({
    resolveSession: (sessionId) => sessionId === "s1" ? { sessionId, projectPath: "/repo" } : undefined,
    onSessionCreated() {},
    onCatalogChanged() {},
    client: () => fakeServe(recorded) as unknown as OpencodeClient,
    now: () => 1000,
  });
  installFetch(recorded, all);
  const page = await backend.page("s1", 0, 300, "nice");
  expect(page.total).toBe(250);
  const ids = page.events.map((event) => event.id);
  expect(ids[0]).toBe("opencode:msg-0");
  expect(ids.at(-1)).toBe("opencode:msg-249");
  await backend.dispose();
});
