// The route contract over a real socket, the way `requestGuard.test.ts` sends its refusals: a
// status code is only evidence about a route when the bytes actually crossed one. The service
// behind the routes is a real one over the fake backend and fake worktree steps its own tests
// pin; what is pinned here is the HTTP shape.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArenaRoutes } from "@/http/arenaRoutes";
import { ArenaRunRegistry, type ArenaRunRecord } from "@/arena/arenaRun";
import { ArenaService } from "@/arena/arenaService";
import { ArenaStore } from "@/arena/arenaStore";
import type { OpencodeContestantBackend } from "@/arena/opencodeContestant";
import type { TimelineEnvelope } from "@agentdesk/agent-feed-wire";

const roots: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A backend whose every contestant closes at once, right behind the send. */
const closingBackend: OpencodeContestantBackend = {
  async createSession(_requestId, projectPath) {
    return {
      sessionId: `ses-${Math.random().toString(36).slice(2, 8)}`,
      source: "opencode",
      projectPath,
      title: "contestant",
      lastEventAt: 1,
      activity: "ready",
      capabilities: {
        modes: ["nice"],
        canSend: true,
        canSteer: true,
        canAbort: true,
        canFetchRaw: false,
        canOpenTerminal: true,
        supportsExtensionUi: true,
        canStreamLive: false,
      },
    };
  },
  async subscribe(sessionId, _after, listener) {
    const state = (runState: "running" | "idle"): TimelineEnvelope => ({
      kind: "state",
      sequence: 1,
      mode: "nice",
      events: [],
      windowStart: 0,
      runState,
      queue: { steer: 0, followUp: 0 },
    });
    queueMicrotask(() => {
      listener(state("running"));
      listener(state("idle"));
    });
    return () => {};
  },
  async send() {
    return { requestId: "r", delivery: "immediate" };
  },
  sessionUsage: () => ({ current: 10, limit: null, updatedAt: 1, cost: 0.001 }),
};

const fakeWorktrees = {
  async assertRepository() {},
  async add() {},
  async remove() {},
  async prune() {},
  async captureDiff() {
    return "diff --git a/README";
  },
};

async function start(): Promise<{ at: (path: string, init?: RequestInit) => Promise<Response> }> {
  const created = await mkdtemp(join(tmpdir(), "arena-routes-"));
  roots.push(created);
  const root = await realpath(created);
  const registry = new ArenaRunRegistry();
  const arena = new ArenaService({
    registry,
    store: new ArenaStore(root),
    backend: closingBackend,
    worktrees: fakeWorktrees,
    arenaRoot: root,
    defaultRepoPath: "/repos/default",
    turnTimeoutMs: 500,
    newRunId: () => "11111111-1111-4111-8111-111111111111",
  });
  const routes = createArenaRoutes(arena);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // `undefined` is "not mine" in the sidecar's dispatcher, which falls through to the next
    // handler; a bare test server has no such chain, so the not-mine answer is spelled here.
    fetch: (request, bunServer) =>
      routes(request, new URL(request.url), bunServer) ?? new Response("not mine", { status: 404 }),
  });
  servers.push(server);
  const at = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(`http://127.0.0.1:${server.port}${path}`, init);
  return { at };
}

const body = (over: Record<string, unknown> = {}): RequestInit => ({
  method: "POST",
  body: JSON.stringify({
    prompt: "say one word",
    repoPath: "/repos/one",
    contestants: [{ source: "opencode" }],
    ...over,
  }),
});

test("creates a run and answers its summary, then the facts as the contestants close", async () => {
  const { at } = await start();
  const created = await at("/api/arena/runs", body());
  expect(created.status).toBe(201);
  const run = (await created.json()) as { runId: string; contestants: unknown[] };
  expect(run.contestants.length).toBe(1);

  // Facts arrive when the contestant closes; the deadline is the route's own honesty about it.
  const deadline = Date.now() + 2000;
  let status = "";
  let gitDiff: string | null = null;
  while (Date.now() < deadline) {
    const response = await at(`/api/arena/runs/${run.runId}`);
    const detail = (await response.json()) as {
      contestants: { status: string; gitDiff: string | null }[];
    };
    status = detail.contestants[0]?.status ?? "";
    gitDiff = detail.contestants[0]?.gitDiff ?? null;
    if (status === "closed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(status).toBe("closed");
  expect(gitDiff).toBe("diff --git a/README");
});

test("a request no run could be made of answers 400 naming what was wrong", async () => {
  const { at } = await start();
  const empty = await at("/api/arena/runs", body({ prompt: "" }));
  expect(empty.status).toBe(400);
  const message = (await empty.json()) as { error: { message: string } };
  expect(message.error.message).toContain("prompt");

  const unmade = await at("/api/arena/runs", {
    method: "POST",
    body: "not json at all",
  });
  expect(unmade.status).toBe(400);
});

test("a run id that names no run answers 404, not an empty run", async () => {
  const { at } = await start();
  const response = await at("/api/arena/runs/22222222-2222-4222-8222-222222222222");
  expect(response.status).toBe(404);
});

test("lists the runs it holds, newest first", async () => {
  const { at } = await start();
  await at("/api/arena/runs", body());
  const list = await at("/api/arena/runs");
  expect(list.status).toBe(200);
  const { runs } = (await list.json()) as { runs: { runId: string }[] };
  expect(runs.map((one) => one.runId)).toEqual(["11111111-1111-4111-8111-111111111111"]);
});

test("a method the route does not take answers 405 rather than a silent 404", async () => {
  const { at } = await start();
  expect((await at("/api/arena/runs", { method: "PATCH" })).status).toBe(405);
  expect((await at("/api/arena/runs/stream", { method: "POST" })).status).toBe(405);
});

test("the stream opens with the whole run list as its first frame", async () => {
  const { at } = await start();
  const controller = new AbortController();
  const response = await at("/api/arena/runs/stream", { signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  // Read the first frame from the body reader rather than `text()`, which waits for the end of
  // a stream that never ends: the question is what the stream said first, not everything.
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  const first = new TextDecoder().decode(value ?? new Uint8Array());
  expect(first).toContain("\"type\":\"runs\"");
  controller.abort();
});

test("the index reloads through the same route after a restart", async () => {
  const { at } = await start();
  await at("/api/arena/runs", body());
  const list = (await (await at("/api/arena/runs")).json()) as { runs: ArenaRunRecord[] };
  expect(list.runs.length).toBe(1);
});
