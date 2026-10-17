import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSdkSessionState } from "@agentdesk/agent-feed-wire";
import { ClaudeSdkClient, NO_RUNNER } from "@/claude-sdk/claudeSdkClient";
import { FakeQuery } from "@/claude-sdk/claudeSdkHarness";
import { runnerSocketPath } from "@/claude-sdk/claudeSdkProtocol";
import { ClaudeSdkRunner, type RunnerPlan } from "@/claude-sdk/claudeSdkRunner";
import { serveRunner } from "@/claude-sdk/claudeSdkRunnerServer";
import { answerOutcome, commandOutcome } from "@/claude-sdk/claudeSdkRoutes";

// Short and under /tmp: a socket path past about 104 bytes fails to bind with nothing to say why.
const work = mkdtempSync("/tmp/sdkc-");
chmodSync(work, 0o700);
afterAll(() => rmSync(work, { recursive: true, force: true }));

let sessionCounter = 0;
const quiet = () => {};

async function runnerFor() {
  const sessionId = `aaaaaaaa-bbbb-4ccc-8ddd-${String(++sessionCounter).padStart(12, "0")}`;
  const plan: RunnerPlan = {
    sessionId,
    cwd: work,
    name: "probe",
    start: "new",
    permissionMode: "auto",
    allowBypass: false,
    pluginDirectories: [],
    claudePath: "/bin/false",
  };
  let fake!: FakeQuery;
  const runner = new ClaudeSdkRunner(plan, ({ prompt, options }) => (fake = new FakeQuery(options, prompt)));
  const server = await serveRunner(runner, { sessionId, socketPath: runnerSocketPath(work, sessionId) }, quiet);
  const done = runner.run(quiet);
  const stop = async () => {
    fake.end();
    await done;
    await server.close();
  };
  return { sessionId, runner, fake: () => fake, stop };
}

/** The next state a listener hears that satisfies `test`. */
function stateWhere(client: ClaudeSdkClient, sessionId: string, test: (state: ClaudeSdkSessionState) => boolean) {
  return new Promise<{ state: ClaudeSdkSessionState; stop: () => void }>((resolve) => {
    let stop = () => {};
    let done = false;
    stop = client.observe(sessionId, (state) => {
      if (!done && test(state)) {
        done = true;
        queueMicrotask(() => resolve({ state, stop }));
      }
    });
  });
}

const ask = {
  questions: [{
    question: "Which tree?",
    header: "Tree",
    multiSelect: false,
    options: [{ label: "Oak", description: "" }, { label: "Birch", description: "" }],
  }],
};

describe("a sidecar that restarts while a question waits", () => {
  test("is handed the question by the runner, and its answer resolves the call", async () => {
    const session = await runnerFor();
    const asked = session.fake().canUseTool("AskUserQuestion", ask, {
      signal: new AbortController().signal,
      toolUseID: "toolu_1",
      requestId: "r1",
    }) as Promise<PermissionResult>;

    const before = new ClaudeSdkClient(work, quiet);
    const first = await stateWhere(before, session.sessionId, (state) => state.pending.length === 1);
    expect(first.state.connected).toBe(true);
    first.stop();

    // The restart: the first client is gone with everything it held, and a new one starts cold.
    const after = new ClaudeSdkClient(work, quiet);
    const seen = await stateWhere(after, session.sessionId, (state) => state.pending.length === 1);
    expect(seen.state.pending[0]).toMatchObject({ kind: "question", toolUseId: "toolu_1" });

    const reply = await after.command(session.sessionId, {
      type: "answer",
      answers: [{ question: "Which tree?", chosen: [{ index: 1, label: "Birch" }], other: "" }],
    });
    expect(reply).toEqual({ ok: true });
    expect(await asked).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which tree?": "Birch" } } });
    seen.stop();
    await session.stop();
  });
});

describe("following a session", () => {
  test("hears a runner that starts after it began looking", async () => {
    const client = new ClaudeSdkClient(work, quiet);
    const sessionId = `aaaaaaaa-bbbb-4ccc-8ddd-${String(sessionCounter + 1).padStart(12, "0")}`;
    const heard: boolean[] = [];
    const stop = client.observe(sessionId, (state) => heard.push(state.connected));
    expect(heard).toEqual([false]);
    const connected = new Promise<void>((resolve) => {
      const unsubscribe = client.observe(sessionId, (state) => state.connected && (unsubscribe(), resolve()));
    });
    const session = await runnerFor();
    expect(session.sessionId).toBe(sessionId);
    await connected;
    expect(heard.at(-1)).toBe(true);
    await session.stop();
    // The runner going away is said too, so a card does not go on showing a question nobody holds.
    for (let tries = 0; heard.at(-1) !== false && tries < 50; tries += 1) await Bun.sleep(10);
    expect(heard.at(-1)).toBe(false);
    stop();
  });

  test("a mode change and a decision come back as the runner's own replies", async () => {
    const session = await runnerFor();
    const client = new ClaudeSdkClient(work, quiet);
    const approval = session.fake().canUseTool("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      toolUseID: "toolu_b",
      requestId: "r2",
    }) as Promise<PermissionResult>;
    expect(await client.command(session.sessionId, { type: "set-mode", mode: "plan" })).toEqual({ ok: true });
    expect(session.fake().modes).toEqual(["plan"]);
    expect(await client.command(session.sessionId, { type: "decide", toolUseId: "toolu_b", allow: false, message: "not now" }))
      .toEqual({ ok: true });
    expect(await approval).toEqual({ behavior: "deny", message: "not now" });
    expect(await client.command(session.sessionId, { type: "decide", toolUseId: "toolu_b", allow: true }))
      .toMatchObject({ ok: false, reason: "not-pending" });
    await session.stop();
  });
});

describe("one runner per session", () => {
  test("a second runner for the same session refuses to start", async () => {
    const session = await runnerFor();
    const second = new ClaudeSdkRunner(
      { sessionId: session.sessionId, cwd: work, name: "x", start: "resume", permissionMode: "auto", allowBypass: false, pluginDirectories: [], claudePath: "/bin/false" },
      () => { throw new Error("must not start"); },
    );
    expect(serveRunner(second, { sessionId: session.sessionId, socketPath: runnerSocketPath(work, session.sessionId) }, quiet))
      .rejects.toThrow("already serving");
    await session.stop();
  });
});

describe("who the client will believe", () => {
  test("nothing in a directory other users can read, whatever answers there", async () => {
    const open = mkdtempSync("/tmp/sdko-");
    chmodSync(open, 0o755);
    try {
      const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-777777777777";
      const runner = new ClaudeSdkRunner(
        { sessionId, cwd: open, name: "x", start: "new", permissionMode: "auto", allowBypass: false, pluginDirectories: [], claudePath: "/bin/false" },
        () => { throw new Error("unused"); },
      );
      const server = await serveRunner(runner, { sessionId, socketPath: runnerSocketPath(open, sessionId) }, quiet);
      expect(await new ClaudeSdkClient(open, quiet).isServing(sessionId)).toBe(false);
      await server.close();
    } finally {
      rmSync(open, { recursive: true, force: true });
    }
  });

  test("nothing from a socket that does not introduce itself as this session's runner", async () => {
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-888888888888";
    const path = runnerSocketPath(work, sessionId);
    const impostor = Bun.listen({
      unix: path,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify({ type: "state", state: { status: "idle", permissionMode: null, allowBypass: true, pending: [], backgroundTasks: 0, claudeCodeVersion: null } })}\n`);
        },
        data() {},
      },
    });
    try {
      expect(await new ClaudeSdkClient(work, quiet).isServing(sessionId)).toBe(false);
    } finally {
      impostor.stop(true);
      rmSync(path, { force: true });
    }
  });
});

describe("what the panel is told", () => {
  test("no runner is its own refusal, for commands and for answers", async () => {
    const client = new ClaudeSdkClient(work, quiet);
    const reply = await client.command("aaaaaaaa-bbbb-4ccc-8ddd-999999999999", { type: "interrupt" });
    expect(reply).toBe(NO_RUNNER);
    expect(commandOutcome(reply)).toMatchObject({ ok: false, reason: "no-runner" });
    expect(answerOutcome([{ question: "Q", chosen: [], other: "my words" }], reply)).toEqual({
      answered: false,
      reason: "no-pane",
      keptText: [{ question: "Q", text: "my words" }],
      sent: false,
    });
  });

  test("a refused answer keeps the reader's words and says which way it was wrong", () => {
    expect(answerOutcome([{ question: "Q", chosen: [], other: "" }], { ok: false, reason: "wrong-dialog", message: "" }))
      .toEqual({ answered: false, reason: "wrong-dialog", keptText: [], sent: false });
    expect(answerOutcome([], { ok: false, reason: "not-pending", message: "" })).toMatchObject({ reason: "no-dialog" });
    expect(answerOutcome([], { ok: false, reason: "failed", message: "" })).toMatchObject({ reason: "pane-stalled" });
  });
});
