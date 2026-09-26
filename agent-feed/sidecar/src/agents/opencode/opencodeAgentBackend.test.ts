import { afterEach, expect, test } from "bun:test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { OpencodeAgentBackend } from "@/agents/opencode/opencodeAgentBackend";
import {
  AgentModeUnsupportedError,
  AgentSessionNotFoundError,
} from "@/agents/agentBackend";
import { LOCAL_OPENCODE_COMMANDS } from "@/agents/opencode/opencodeServeCalls";

interface Recorded {
  prompts: Array<{ sessionID: string; text: string; delivery: string; files?: Array<{ uri: string; mime: string; name: string }> }>;
  ran: Array<{ sessionID: string; name: string; text: string }>;
  switched: Array<{ sessionID: string; model: unknown }>;
  localOps: string[];
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

function fakeServe(recorded: Recorded, session = sessionInfo()) {
  return {
    v2: {
      session: {
        get: async () => ({ data: { data: session } }),
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
    if (parsed.pathname === "/api/command") {
      return Response.json({ data: [{ name: "review", description: "review changes" }, { name: "lonely" }] });
    }
    if (parsed.pathname === "/api/model") {
      return Response.json({ data: [
        { providerID: "opencode-go", modelID: "muse-spark", name: "Muse Spark", limit: { context: 1000 }, cost: [{ input: 1, output: 2 }] },
        { providerID: "opencode", modelID: "plain", name: "", limit: {}, cost: [] },
      ] });
    }
    if (parsed.pathname.endsWith("/model")) {
      const body = JSON.parse(String(init?.body)) as { model?: { providerID?: string; id?: string } };
      recorded.switched.push({ sessionID: parsed.pathname.split("/").at(-2) ?? "", model: body.model ?? {} });
      return new Response(null, { status: 204 });
    }
    if (parsed.pathname.endsWith("/command")) {
      const body = JSON.parse(String(init?.body)) as { name?: string; text?: string };
      recorded.ran.push({
        sessionID: parsed.pathname.split("/").at(-2) ?? "",
        name: body.name ?? "",
        text: body.text ?? "",
      });
      return Response.json({ data: {} });
    }
    if (parsed.pathname.endsWith("/compact") || parsed.pathname.endsWith("/revert/stage") || parsed.pathname.endsWith("/revert/commit")) {
      recorded.localOps.push(`${init?.method ?? "POST"} ${parsed.pathname.split("/").slice(-2).join("/")} ${String(init?.body)}`);
      return Response.json({ data: {} });
    }
    if (parsed.pathname.endsWith("/revert") && init?.method === "DELETE") {
      recorded.localOps.push("DELETE revert");
      return Response.json({ data: {} });
    }
    if (parsed.pathname.endsWith("/fork")) {
      recorded.localOps.push(`POST fork ${String(init?.body)}`);
      return Response.json({ data: { id: "s-fork", title: "Forked" } });
    }
    if (parsed.pathname.endsWith("/s1") && init?.method === "PATCH") {
      recorded.localOps.push(`PATCH session ${String(init?.body)}`);
      return new Response(null, { status: 204 });
    }
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
  const recorded: Recorded = { prompts: [], ran: [], switched: [], localOps: [], interrupts: [], permissionReplies: [], created: [] };
  installFetch(recorded, [userItem("msg-u", "hello")]);
  const registered: string[] = [];
  const backend = new OpencodeAgentBackend({
    resolveSession: (sessionId) =>
      sessionId === "s1" ? { sessionId, projectPath: "/repo" } : undefined,
    // What a command made rather than drove, in the order it was made: a fork registers the same
    // way a create does, and a test that cannot see it is a test that cannot tell the two apart.
    onSessionCreated: (location) => registered.push(`${location.sessionId}@${location.projectPath}`),
    onCatalogChanged: () => { recorded.localOps.push("catalog re-read"); },
    client: () => fakeServe(recorded) as unknown as OpencodeClient,
    now: () => 1000,
  });
  return { backend, recorded, registered };
}

test("timeline serves nice mode only", async () => {
  const { backend } = fixture();
  const page = await backend.page("s1", 0, 10, "nice");
  expect(page).toMatchObject({ mode: "nice", total: 1 });
  expect(backend.sessionUsage("s1")).toEqual(expect.objectContaining({ model: "p/m", limit: null }));
  expect(backend.sessionModel("s1")).toBe("p/m");
  await expect(backend.page("s1", 0, 10, "raw")).rejects.toBeInstanceOf(AgentModeUnsupportedError);
  await expect(backend.page("nope", 0, 10, "nice")).rejects.toBeInstanceOf(AgentSessionNotFoundError);
  await backend.dispose();
});

test("the session model survives the post-compaction gap that blanks usage", async () => {
  // A landed compaction with no turn reporting tokens after it: the meter blanks rather than
  // holding a pre-compaction number, but the switcher must keep naming the model -- a
  // compaction rewrites context, never the model.
  const recorded: Recorded = { prompts: [], ran: [], switched: [], localOps: [], interrupts: [], permissionReplies: [], created: [] };
  installFetch(recorded, [
    { id: "msg-c", time: { created: 200 }, type: "compaction", status: "completed" },
    userItem("msg-u", "hello"),
  ] as unknown as FakeItem[]);
  const backend = new OpencodeAgentBackend({
    resolveSession: (sessionId) =>
      sessionId === "s1" ? { sessionId, projectPath: "/repo" } : undefined,
    onSessionCreated() {},
    onCatalogChanged() {},
    client: () => fakeServe(recorded) as unknown as OpencodeClient,
    now: () => 1000,
  });
  await backend.page("s1", 0, 10, "nice");
  expect(backend.sessionUsage("s1")).toBeNull();
  expect(backend.sessionModel("s1")).toBe("p/m");
  await backend.dispose();
});

test("the session model is named even when the serve reports no token totals", async () => {
  // A fresh session the serve names a model for but reports no tokens on yet: there is no
  // occupancy to derive anything from, but the switcher must still name the model.
  const recorded: Recorded = { prompts: [], ran: [], switched: [], localOps: [], interrupts: [], permissionReplies: [], created: [] };
  const { model, ...withoutTokens } = sessionInfo();
  installFetch(recorded, [userItem("msg-u", "hello")]);
  const backend = new OpencodeAgentBackend({
    resolveSession: (sessionId) =>
      sessionId === "s1" ? { sessionId, projectPath: "/repo" } : undefined,
    onSessionCreated() {},
    onCatalogChanged() {},
    client: () => fakeServe(recorded, { ...withoutTokens, model }) as unknown as OpencodeClient,
    now: () => 1000,
  });
  await backend.page("s1", 0, 10, "nice");
  expect(backend.sessionModel("s1")).toBe("p/m");
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

test("commands list from the serve and run natively with the draft as arguments", async () => {
  const { backend, recorded } = fixture();
  const receipt = await backend.runCommand("s1", "r-cmd", "review", "the last commit");
  expect(receipt).toEqual({ requestId: "r-cmd", delivery: "immediate" });
  expect(recorded.ran).toEqual([{ sessionID: "s1", name: "review", text: "the last commit" }]);
  // A repeated request answers from the ledger without touching the serve again.
  await backend.runCommand("s1", "r-cmd", "review", "the last commit");
  expect(recorded.ran).toHaveLength(1);
  await backend.dispose();
});

test("local ops compact, undo, redo and rename through their native endpoints", async () => {
  const { backend, recorded } = fixture();
  await backend.runLocalCommand("s1", "r-compact", "compact", "");
  await backend.runLocalCommand("s1", "r-undo", "undo", "");
  await backend.runLocalCommand("s1", "r-redo", "redo", "");
  await backend.runLocalCommand("s1", "r-rename", "rename", "New title");
  expect(recorded.localOps).toEqual([
    'POST s1/compact {}',
    expect.stringContaining('"messageID":"msg-u"'),
    'POST revert/commit {}',
    'DELETE revert',
    'PATCH session {"title":"New title"}',
    "catalog re-read", // the serve announces nothing for a title change, so the rename tells the catalog
  ]);
  await backend.dispose();
});

test("fork answers with the session it made, registered so the panel can open it", async () => {
  const { backend, recorded, registered } = fixture();
  const receipt = await backend.runCommand("s1", "r-fork", "fork", "");
  expect(recorded.localOps).toEqual(['POST fork {}']);
  // The descriptor is assembled here rather than taken whole from the serve, so the panel has
  // something it can open: the fork's own id, the project it belongs to, and this backend's
  // capabilities.
  expect(receipt).toEqual({
    requestId: "r-fork",
    delivery: "immediate",
    session: {
      sessionId: "s-fork", source: "opencode", projectPath: "/repo", title: "Forked",
      lastEventAt: 1000, activity: "ready", capabilities: backend.capabilities,
    },
  });
  // Registered with the pool, or the panel would never see the session it was just told about.
  expect(registered).toEqual(["s-fork@/repo"]);
  await backend.dispose();
});

test("runCommand sorts local names natively and lists them with server commands", async () => {
  const { backend, recorded } = fixture();
  await backend.runCommand("s1", "r-l", "compact", "");
  expect(recorded.localOps).toEqual(["POST s1/compact {}"]);
  expect(recorded.ran).toHaveLength(0);
  // The serve's own commands first, then the mirrored web set: the picker shows one list, and the
  // seam between the two is what this route has to keep.
  await expect(backend.listCommands().then((list) => list.map((command) => command.name))).resolves.toEqual([
    "review", "lonely", ...LOCAL_OPENCODE_COMMANDS.map((command) => command.name),
  ]);
  await backend.dispose();
});

test("local ops refuse an unknown name and an empty undo or rename", async () => {
  const { backend, recorded } = fixture();
  await expect(backend.runLocalCommand("s1", "r-x", "nope", "")).rejects.toThrow('unknown local command "nope"');
  await expect(backend.runLocalCommand("s1", "r-t", "rename", "  ")).rejects.toThrow("rename needs a title");
  expect(recorded.localOps).toHaveLength(0);
  await backend.dispose();
});

test("models list with limits and switch natively", async () => {
  const { backend, recorded } = fixture();
  await expect(backend.listModels()).resolves.toEqual([
    { providerID: "opencode-go", modelID: "muse-spark", name: "Muse Spark", contextLimit: 1000, inputCost: 1, outputCost: 2 },
    { providerID: "opencode", modelID: "plain", name: "plain", contextLimit: null, inputCost: null, outputCost: null },
  ]);
  const receipt = await backend.switchModel("s1", "r-m", "opencode-go", "muse-spark");
  expect(receipt).toEqual({ requestId: "r-m", delivery: "immediate" });
  expect(recorded.switched).toEqual([
    { sessionID: "s1", model: { providerID: "opencode-go", id: "muse-spark" } },
  ]);
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
  const recorded: Recorded = { prompts: [], ran: [], switched: [], localOps: [], interrupts: [], permissionReplies: [], created: [] };
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
  const recorded: Recorded = { prompts: [], ran: [], switched: [], localOps: [], interrupts: [], permissionReplies: [], created: [] };
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
  const recorded: Recorded = { prompts: [], ran: [], switched: [], localOps: [], interrupts: [], permissionReplies: [], created: [] };
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

test("a picture a call returned is served back by its event and block address", async () => {
  // The pool stores what the mapper collected at sync time; the image route reads it back by
  // the same address the panel was given. Event 0 is the prompt, event 1 the turn whose third
  // block is the picture.
  const recorded: Recorded = { prompts: [], ran: [], switched: [], localOps: [], interrupts: [], permissionReplies: [], created: [] };
  const data = Buffer.from("fake-png-bytes").toString("base64");
  installFetch(recorded, [
    {
      id: "msg-a",
      time: { created: 200, completed: 300 },
      type: "assistant",
      agent: "build",
      model: { id: "m", providerID: "p" },
      content: [{
        type: "tool",
        id: "c1",
        name: "read",
        state: {
          status: "completed",
          input: { path: "/tmp/shot.png" },
          content: [
            { type: "text", text: "Image read successfully" },
            { type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png" },
          ],
          structured: {},
        },
      }],
    },
    userItem("msg-u", "hi"),
  ] as unknown as FakeItem[]);
  const backend = new OpencodeAgentBackend({
    resolveSession: (sessionId) =>
      sessionId === "s1" ? { sessionId, projectPath: "/repo" } : undefined,
    onSessionCreated() {},
    onCatalogChanged() {},
    client: () => fakeServe(recorded) as unknown as OpencodeClient,
    now: () => 1000,
  });
  const page = await backend.page("s1", 0, 10, "nice");
  expect(page.total).toBe(2);
  expect(backend.opencodeImage("s1", 1, 2)).toEqual({ mediaType: "image/png", data });
  // The result block beside it, the prompt's row, and a stranger's session name no picture.
  expect(backend.opencodeImage("s1", 1, 1)).toBeNull();
  expect(backend.opencodeImage("s1", 0, 0)).toBeNull();
  expect(backend.opencodeImage("nope", 1, 2)).toBeNull();
  await backend.dispose();
});
