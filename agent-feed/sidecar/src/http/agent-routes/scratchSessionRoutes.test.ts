import { expect, test } from "bun:test";
import { splitScratchBrief } from "@agentdesk/agent-feed-wire";
import { createScratchSessionRoutes, type ScratchSessionActions } from "@/http/agent-routes/scratchSessionRoutes";
import type { SessionLauncher } from "@/transcripts/session-ops/forkSession";

const server = { upgrade: () => false } as unknown as Parameters<ReturnType<typeof createScratchSessionRoutes>>[2];
const FOLDER = "/scratch/plan-the-garden-1a2b";

function harness(options: { launchFails?: boolean } = {}) {
  const calls: string[] = [];
  const prompts: string[] = [];
  const launcher: SessionLauncher = {
    async start(start) {
      calls.push(`start ${start.cwd} ${start.title} [${start.mode ?? "terminal"}]`);
      prompts.push(start.prompt ?? "");
      if (options.launchFails) throw new Error("tmux new-session exited 1");
      return { tmuxSession: `agentdesk-${start.sessionId}` };
    },
    async fork() {
      throw new Error("a scratch start never forks");
    },
    async end() {
      return null;
    },
  };
  const actions: ScratchSessionActions = {
    launch: launcher,
    makeFolder: async (title) => {
      calls.push(`make ${title}`);
      return FOLDER;
    },
    removeFolder: async (path) => {
      calls.push(`remove ${path}`);
    },
  };
  const routes = createScratchSessionRoutes(actions);
  const post = async (body: Record<string, unknown>) => {
    const request = new Request("http://localhost/api/agent-sessions/start-scratch", {
      method: "POST",
      body: JSON.stringify({ requestId: "chat-1", ...body }),
    });
    const response = await routes(request, new URL(request.url), server);
    return { status: response!.status, body: (await response!.json()) as Record<string, unknown> };
  };
  return { calls, prompts, post };
}

test("a chat makes its folder, then starts in it through the SDK, named from its message", async () => {
  const { calls, prompts, post } = harness();
  const answer = await post({ prompt: "  Plan the garden\nwith raised beds " });
  expect(answer.status).toBe(201);
  expect(answer.body).toMatchObject({ source: "claude", title: "Plan the garden", projectPath: FOLDER });
  expect(calls).toEqual(["make Plan the garden", `start ${FOLDER} Plan the garden [sdk]`]);
  const split = splitScratchBrief(prompts[0]!);
  expect(split?.rest).toBe("Plan the garden\nwith raised beds");
  expect(split?.brief).toContain(FOLDER);
});

test("a chat with nothing typed makes nothing", async () => {
  const { calls, post } = harness();
  const answer = await post({ prompt: "   " });
  expect(answer.status).toBe(400);
  expect(calls).toEqual([]);
});

test("a start that fails takes its folder with it and says why", async () => {
  const { calls, post } = harness({ launchFails: true });
  const answer = await post({ prompt: "Plan the garden" });
  expect(answer.status).toBe(500);
  expect(JSON.stringify(answer.body)).toContain("tmux new-session exited 1");
  expect(calls).toEqual(["make Plan the garden", `start ${FOLDER} Plan the garden [sdk]`, `remove ${FOLDER}`]);
});

test("other paths are not this route's", async () => {
  const routes = createScratchSessionRoutes();
  const request = new Request("http://localhost/api/agent-sessions/start", { method: "POST" });
  expect(await routes(request, new URL(request.url), server)).toBeUndefined();
});
