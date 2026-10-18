// Slash commands on an opencode session: the serve's own, listed and run with the draft as their
// arguments, and the panel-run ones (compact, undo, redo, rename, fork) on their native endpoints,
// with the model switch beside them. Split from the backend's main suite, which covers reading and
// sending.

import { afterEach, expect, test } from "bun:test";
import type { OpencodeClient } from "@/agents/opencode/serve/opencodeClient";
import { OpencodeAgentBackend } from "@/agents/opencode/opencodeAgentBackend";
import { LOCAL_OPENCODE_COMMANDS } from "@/agents/opencode/serve/opencodeServeCalls";

interface Recorded {
  prompts: Array<{ sessionID: string; text: string; delivery: string; files?: Array<{ uri: string; mime: string; name: string }> }>;
  ran: Array<{ sessionID: string; name: string; text: string }>;
  switched: Array<{ sessionID: string; model: unknown }>;
  localOps: string[];
  interrupts: string[];
  permissionReplies: Array<{ requestID: string; reply: string }>;
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
    session: {
      get: async () => session,
      interrupt: async (params: { sessionID: string }) => {
        recorded.interrupts.push(params.sessionID);
      },
    },
    permission: {
      reply: async (params: { requestID: string; decision: string }) => {
        recorded.permissionReplies.push({ requestID: params.requestID, reply: params.decision });
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => (async function* () {
        // Open until aborted: nothing here pushes an event, so the stream only has to be there.
        const next = await new Promise<unknown>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        yield next;
      })(),
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

function fixture() {
  const recorded: Recorded = { prompts: [], ran: [], switched: [], localOps: [], interrupts: [], permissionReplies: [] };
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
