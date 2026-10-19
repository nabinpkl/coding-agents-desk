import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSdkSessionState } from "@agentdesk/agent-feed-wire";
import { ClaudeSdkClient, NO_RUNNER } from "@/claude-sdk/session/claudeSdkClient";
import { FakeQuery } from "@/claude-sdk/claudeSdkHarness";
import { PROTOCOL_VERSION, runnerBuild, runnerSocketPath } from "@/claude-sdk/claudeSdkProtocol";
import { ClaudeSdkRunner, type RunnerPlan } from "@/claude-sdk/claudeSdkRunner";
import { serveRunner } from "@/claude-sdk/claudeSdkRunnerServer";
import { answerOutcome, commandOutcome } from "@/claude-sdk/claudeSdkRoutes";

// Short and under /tmp: a socket path past about 104 bytes fails to bind with nothing to say why.
const work = mkdtempSync("/tmp/sdkc-");
chmodSync(work, 0o700);
afterAll(() => rmSync(work, { recursive: true, force: true }));

let sessionCounter = 0;
const quiet = () => {};
const BUILD = runnerBuild();

async function runnerFor(build = BUILD, choices: RunnerPlan["choices"] = {}) {
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
    choices,
  };
  let fake!: FakeQuery;
  const runner = new ClaudeSdkRunner(plan, ({ prompt, options }) => (fake = new FakeQuery(options, prompt)));
  const server = await serveRunner(runner, { sessionId, socketPath: runnerSocketPath(work, sessionId), build }, quiet);
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
  questions: [
    {
      question: "Which tree?",
      header: "Tree",
      multiSelect: false,
      options: [
        { label: "Oak", description: "" },
        { label: "Birch", description: "" },
      ],
    },
  ],
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
    const approval = session.fake().canUseTool(
      "Bash",
      { command: "ls" },
      {
        signal: new AbortController().signal,
        toolUseID: "toolu_b",
        requestId: "r2",
      },
    ) as Promise<PermissionResult>;
    expect(await client.command(session.sessionId, { type: "set-mode", mode: "plan" })).toEqual({ ok: true });
    expect(session.fake().modes).toEqual(["plan"]);
    expect(
      await client.command(session.sessionId, {
        type: "decide",
        toolUseId: "toolu_b",
        allow: false,
        message: "not now",
      }),
    ).toEqual({ ok: true });
    expect(await approval).toEqual({ behavior: "deny", message: "not now" });
    expect(
      await client.command(session.sessionId, { type: "decide", toolUseId: "toolu_b", allow: true }),
    ).toMatchObject({ ok: false, reason: "not-pending" });
    await session.stop();
  });
});

describe("what a runner streams", () => {
  test("reaches the sink as it arrives, and the sink hears when the runner goes", async () => {
    const heard: string[] = [];
    const session = await runnerFor();
    const client = new ClaudeSdkClient(work, quiet, {
      stream: (sessionId, frame) => void heard.push(`${sessionId === session.sessionId} ${frame.event.type}`),
      gone: () => void heard.push("gone"),
    });
    const followed = await stateWhere(client, session.sessionId, (state) => state.connected);
    session.fake().send({ type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null });
    for (let tries = 0; heard.length === 0 && tries < 50; tries += 1) await Bun.sleep(10);
    await session.stop();
    for (let tries = 0; !heard.includes("gone") && tries < 50; tries += 1) await Bun.sleep(10);
    expect(heard).toEqual(["true message_start", "gone"]);
    followed.stop();
  });
});

describe("the choices a runner was launched with", () => {
  test("show as the session's model and effort, and come back for the next launch with any made since", async () => {
    const session = await runnerFor(BUILD, { model: "haiku", effort: "max" });
    const client = new ClaudeSdkClient(work, quiet);
    const followed = await stateWhere(client, session.sessionId, (state) => state.connected);
    // The runner launched in auto (`runnerFor`'s plan), which it says before any turn has run.
    expect(followed.state).toMatchObject({ model: "haiku", effort: "max", permissionMode: "auto" });
    expect(await client.choices(session.sessionId)).toEqual({ model: "haiku", effort: "max" });
    expect(await client.command(session.sessionId, { type: "set-model", model: "opus" })).toEqual({ ok: true });
    for (let tries = 0; (await client.choices(session.sessionId)).model !== "opus" && tries < 50; tries += 1)
      await Bun.sleep(10);
    expect(await client.choices(session.sessionId)).toEqual({ model: "opus", effort: "max" });
    followed.stop();
    await session.stop();
  });
});

describe("a prompt sent while a turn runs", () => {
  test("shows as queued, and one sent while idle does not", async () => {
    const session = await runnerFor();
    const client = new ClaudeSdkClient(work, quiet);
    const followed = await stateWhere(client, session.sessionId, (state) => state.connected);
    expect(await client.command(session.sessionId, { type: "prompt", text: "first" })).toEqual({ ok: true });
    expect((await client.state(session.sessionId)).queued).toEqual([]);
    expect(await client.command(session.sessionId, { type: "prompt", text: "second" })).toEqual({ ok: true });
    expect((await client.state(session.sessionId)).queued.map((entry) => entry.text)).toEqual(["second"]);
    followed.stop();
    await session.stop();
  });
});

describe("a prompt larger than one socket write", () => {
  test("reaches the runner whole, its image intact", async () => {
    const session = await runnerFor();
    const client = new ClaudeSdkClient(work, quiet);
    const followed = await stateWhere(client, session.sessionId, (state) => state.connected);
    // A phone screenshot is a few hundred KB; this is well past one 8 KiB write either way.
    const data = Buffer.alloc(6 * 1024 * 1024, 7).toString("base64");
    const reply = await client.command(session.sessionId, {
      type: "prompt",
      text: "what is in this?",
      images: [{ mediaType: "image/png", data }],
    });
    expect(reply).toEqual({ ok: true });
    for (let tries = 0; session.fake().received.length === 0 && tries < 50; tries += 1) await Bun.sleep(10);
    const content = session.fake().received[0]?.message.content as { source?: { data: string } }[];
    expect(content[0]?.source?.data).toBe(data);
    // And the connection still reads: the next command is answered, not glued to a leftover.
    expect(await client.command(session.sessionId, { type: "prompt", text: "and this?" })).toEqual({ ok: true });
    followed.stop();
    await session.stop();
  });
});

describe("the effort a session runs at", () => {
  test("is the CLI's own word before any turn, until a level is chosen, which then wins", async () => {
    const session = await runnerFor();
    const client = new ClaudeSdkClient(work, quiet);
    const followed = await stateWhere(client, session.sessionId, (state) => state.effort !== null);
    // What `getSettings().applied` said, with no turn run: the fake answers as the CLI did when measured.
    // Idle too: the CLI answering is what says it is up, where its `init` waits for a first turn.
    expect(followed.state).toMatchObject({ effort: "high", model: "claude-opus-5-5", status: "idle" });
    expect(await client.command(session.sessionId, { type: "set-effort", effort: "max" })).toEqual({ ok: true });
    for (let tries = 0; (await client.state(session.sessionId)).effort !== "max" && tries < 50; tries += 1)
      await Bun.sleep(10);
    expect((await client.state(session.sessionId)).effort).toBe("max");
    followed.stop();
    await session.stop();
  });
});

describe("a runner on older code", () => {
  test("is said to be stale on every state, and is read as usual meanwhile", async () => {
    const session = await runnerFor("0.0.1+older");
    const stale: boolean[] = [];
    const client = new ClaudeSdkClient(
      work,
      quiet,
      null,
      (_client, _sessionId, state) => void stale.push(state.connected),
    );
    const followed = await stateWhere(client, session.sessionId, (state) => state.connected);
    session.fake().send({ type: "system", subtype: "init", permissionMode: "auto" });
    for (let tries = 0; stale.length < 2 && tries < 50; tries += 1) await Bun.sleep(10);
    expect(stale.length).toBeGreaterThanOrEqual(2);
    expect(stale.every(Boolean)).toBe(true);
    expect(await client.command(session.sessionId, { type: "set-mode", mode: "plan" })).toEqual({ ok: true });
    followed.stop();
    await session.stop();
  });

  test("one speaking an older protocol reads as not connected, and is said to be stale", async () => {
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-666666666666";
    const path = runnerSocketPath(work, sessionId);
    const older = Bun.listen({
      unix: path,
      socket: {
        open(socket) {
          socket.write(`${JSON.stringify({ type: "hello", version: PROTOCOL_VERSION - 1, sessionId, pid: 1 })}\n`);
        },
        data() {},
      },
    });
    try {
      const stale: string[] = [];
      const client = new ClaudeSdkClient(
        work,
        quiet,
        null,
        (_client, id, state) => void stale.push(`${id} ${state.connected}`),
      );
      expect(await client.isServing(sessionId)).toBe(false);
      expect(stale).toEqual([`${sessionId} false`]);
    } finally {
      older.stop(true);
      rmSync(path, { force: true });
    }
  });
});

describe("one runner per session", () => {
  test("a second runner for the same session refuses to start", async () => {
    const session = await runnerFor();
    const second = new ClaudeSdkRunner(
      {
        sessionId: session.sessionId,
        cwd: work,
        name: "x",
        start: "resume",
        permissionMode: "auto",
        allowBypass: false,
        pluginDirectories: [],
        claudePath: "/bin/false",
        choices: {},
      },
      () => {
        throw new Error("must not start");
      },
    );
    expect(
      serveRunner(
        second,
        { sessionId: session.sessionId, socketPath: runnerSocketPath(work, session.sessionId), build: BUILD },
        quiet,
      ),
    ).rejects.toThrow("already serving");
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
        {
          sessionId,
          cwd: open,
          name: "x",
          start: "new",
          permissionMode: "auto",
          allowBypass: false,
          pluginDirectories: [],
          claudePath: "/bin/false",
          choices: {},
        },
        () => {
          throw new Error("unused");
        },
      );
      const server = await serveRunner(
        runner,
        { sessionId, socketPath: runnerSocketPath(open, sessionId), build: BUILD },
        quiet,
      );
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
          socket.write(
            `${JSON.stringify({ type: "state", state: { status: "idle", permissionMode: null, allowBypass: true, pending: [], backgroundTasks: 0, claudeCodeVersion: null } })}\n`,
          );
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
    expect(
      answerOutcome([{ question: "Q", chosen: [], other: "" }], { ok: false, reason: "wrong-dialog", message: "" }),
    ).toEqual({ answered: false, reason: "wrong-dialog", keptText: [], sent: false });
    expect(answerOutcome([], { ok: false, reason: "not-pending", message: "" })).toMatchObject({ reason: "no-dialog" });
    expect(answerOutcome([], { ok: false, reason: "failed", message: "" })).toMatchObject({ reason: "pane-stalled" });
  });
});
