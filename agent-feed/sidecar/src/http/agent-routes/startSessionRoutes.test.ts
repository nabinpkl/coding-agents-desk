import { expect, test } from "bun:test";
import type { AgentBackend } from "@/agents/agentBackend";
import { createStartSessionRoutes, type StartSessionActions } from "@/http/agent-routes/startSessionRoutes";
import type { SessionLauncher } from "@/transcripts/session-ops/forkSession";

const server = { upgrade: () => false } as unknown as Parameters<ReturnType<typeof createStartSessionRoutes>>[2];
const PROJECT = "/Users/reader/projects/garden";

/** Everything that touches the world, recorded in the order it happened. */
function harness(
  options: {
    installed?: boolean;
    paneFails?: boolean;
    knownPath?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const launcher: SessionLauncher = {
    async start(start) {
      calls.push(
        `claude start ${start.cwd} ${start.title} ${start.prompt ?? "-"}${start.mode ? ` [${start.mode}]` : ""}`,
      );
      return { tmuxSession: `agentdesk-${start.sessionId}` };
    },
    async fork() {
      throw new Error("a start never forks");
    },
    async end() {
      return null;
    },
  };
  const actions: StartSessionActions = {
    launch: launcher,
    opencodeInstalled: () => options.installed ?? true,
    startOpencodePane: async (pane) => {
      calls.push(`pane ${pane.sessionId} ${pane.cwd} ${pane.title}`);
      if (options.paneFails) throw new Error("tmux new-session exited 1");
      return "garden-notes";
    },
    projectPath: async (requested) => ((options.knownPath ?? true) && requested === PROJECT ? PROJECT : null),
  };
  const opencode = {
    async createSession(_requestId: string, projectPath: string) {
      calls.push(`opencode create ${projectPath}`);
      return { sessionId: "ses_garden" };
    },
    async renameSession(sessionId: string, title: string) {
      calls.push(`opencode rename ${sessionId} ${title}`);
    },
    async send(sessionId: string, _requestId: string, text: string) {
      calls.push(`opencode send ${sessionId} ${text}`);
      return {};
    },
  };
  const routes = createStartSessionRoutes(
    (id) => (id === "opencode" ? (opencode as unknown as AgentBackend) : undefined),
    actions,
  );
  const post = async (body: Record<string, unknown>) => {
    const request = new Request("http://localhost/api/agent-sessions/start", {
      method: "POST",
      body: JSON.stringify({ requestId: "start-1", projectPath: PROJECT, title: "Garden notes", ...body }),
    });
    const response = await routes(request, new URL(request.url), server);
    return { status: response!.status, body: (await response!.json()) as Record<string, unknown> };
  };
  return { calls, post };
}

test("a Claude session starts in its own pane, in the picked directory, under its title", async () => {
  const { calls, post } = harness();
  const answer = await post({ source: "claude", prompt: "  Sort the beds by sunlight\n" });
  expect(answer.status).toBe(201);
  expect(answer.body).toMatchObject({ source: "claude", title: "Garden notes", projectPath: PROJECT });
  expect(answer.body.tmuxSession).toBe(`agentdesk-${answer.body.sessionId}`);
  expect(calls).toEqual([`claude start ${PROJECT} Garden notes Sort the beds by sunlight`]);
});

test("a Claude session with no first message starts idle", async () => {
  const { calls, post } = harness();
  expect((await post({ source: "claude", prompt: "   " })).status).toBe(201);
  expect(calls).toEqual([`claude start ${PROJECT} Garden notes -`]);
});

test("a Claude session asked for in SDK mode is started that way, and the terminal stays the default", async () => {
  const { calls, post } = harness();
  expect((await post({ source: "claude", claudeMode: "sdk", prompt: "go" })).status).toBe(201);
  expect((await post({ source: "claude", claudeMode: "terminal" })).status).toBe(201);
  expect(calls).toEqual([
    `claude start ${PROJECT} Garden notes go [sdk]`,
    `claude start ${PROJECT} Garden notes - [terminal]`,
  ]);
});

test("a run mode is refused for opencode, and an unknown one for anything", async () => {
  const { calls, post } = harness();
  expect((await post({ source: "opencode", claudeMode: "sdk" })).status).toBe(400);
  expect((await post({ source: "claude", claudeMode: "headless" })).status).toBe(400);
  expect(calls).toEqual([]);
});

test("an opencode session is created, named, given its pane, then its first message", async () => {
  const { calls, post } = harness();
  const answer = await post({ source: "opencode", prompt: "Sort the beds" });
  expect(answer.status).toBe(201);
  expect(answer.body).toEqual({
    source: "opencode",
    sessionId: "ses_garden",
    title: "Garden notes",
    projectPath: PROJECT,
    tmuxSession: "garden-notes",
  });
  expect(calls).toEqual([
    `opencode create ${PROJECT}`,
    "opencode rename ses_garden Garden notes",
    `pane ses_garden ${PROJECT} Garden notes`,
    "opencode send ses_garden Sort the beds",
  ]);
});

test("an opencode session with no first message is sent nothing", async () => {
  const { calls, post } = harness();
  expect((await post({ source: "opencode" })).status).toBe(201);
  expect(calls.some((call) => call.startsWith("opencode send"))).toBe(false);
});

test("a machine without opencode refuses before the serve makes a session", async () => {
  const { calls, post } = harness({ installed: false });
  const answer = await post({ source: "opencode" });
  expect(answer.status).toBe(503);
  expect(calls).toEqual([]);
});

test("a pane that fails after the create names the session that now exists", async () => {
  const { post } = harness({ paneFails: true });
  const answer = await post({ source: "opencode", prompt: "Sort the beds" });
  expect(answer.status).toBe(500);
  expect((answer.body.error as { message: string }).message).toBe(
    "the opencode session ses_garden was created, but opening its pane failed: tmux new-session exited 1",
  );
});

test("refusals start nothing", async () => {
  const { calls, post } = harness({ knownPath: false });
  expect((await post({ source: "claude" })).status).toBe(404);
  const { calls: others, post: postOther } = harness();
  expect((await postOther({ source: "codex" })).status).toBe(400);
  expect((await postOther({ source: "claude", title: "  " })).status).toBe(400);
  expect((await postOther({ source: "claude", title: "two\nlines" })).status).toBe(400);
  expect((await postOther({ source: "claude", prompt: 42 })).status).toBe(400);
  expect((await postOther({ source: "claude", prompt: "x".repeat(32_769) })).status).toBe(400);
  expect([...calls, ...others]).toEqual([]);
});
