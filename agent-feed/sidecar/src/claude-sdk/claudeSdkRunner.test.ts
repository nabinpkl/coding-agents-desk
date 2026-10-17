import { describe, expect, test } from "bun:test";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { FakeQuery } from "@/claude-sdk/claudeSdkHarness";
import { ClaudeSdkRunner, sdkAnswers, type RunnerPlan } from "@/claude-sdk/claudeSdkRunner";

const PLAN: RunnerPlan = {
  sessionId: "11111111-2222-4333-8444-555555555555",
  cwd: "/tmp/project",
  name: "Probe session",
  start: "new",
  permissionMode: "auto",
  allowBypass: true,
  pluginDirectories: ["/mods/prompt-guard"],
  claudePath: "/usr/local/bin/claude",
};

function started(plan: RunnerPlan = PLAN) {
  let fake!: FakeQuery;
  const runner = new ClaudeSdkRunner(plan, ({ prompt, options }) => (fake = new FakeQuery(options, prompt)), () => 1000);
  const done = runner.run(() => {});
  return { runner, fake: () => fake, done };
}

const ask = {
  questions: [
    {
      question: "Which tree do you prefer?",
      header: "Tree",
      multiSelect: false,
      options: [{ label: "Oak", description: "Sturdy" }, { label: "Birch", description: "White bark" }],
    },
  ],
};

function call(fake: FakeQuery, toolName: string, input: Record<string, unknown>, toolUseID: string, extra = {}) {
  const abort = new AbortController();
  const result = fake.canUseTool(toolName, input, { signal: abort.signal, toolUseID, requestId: `req-${toolUseID}`, ...extra }) as Promise<PermissionResult>;
  return { result, abort };
}

describe("the options a plan comes to", () => {
  test("a new session at its id, through the installed CLI, in the launch mode, with summaries on", () => {
    const options = new ClaudeSdkRunner(PLAN, () => { throw new Error("unused"); }).options();
    expect(options).toMatchObject({
      cwd: "/tmp/project",
      sessionId: PLAN.sessionId,
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      permissionMode: "auto",
      allowDangerouslySkipPermissions: true,
      plugins: [{ type: "local", path: "/mods/prompt-guard" }],
      thinking: { type: "adaptive", display: "summarized" },
      includePartialMessages: true,
      extraArgs: { name: "Probe session" },
    });
    expect(options.resume).toBeUndefined();
  });

  test("a resume names the session to resume, keeps its name, and says the CLI's manual as default", () => {
    const options = new ClaudeSdkRunner({ ...PLAN, start: "resume", permissionMode: "manual", allowBypass: false }, () => {
      throw new Error("unused");
    }).options();
    expect(options.resume).toBe(PLAN.sessionId);
    expect(options.sessionId).toBeUndefined();
    expect(options.permissionMode).toBe("default");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.extraArgs).toEqual({ name: "Probe session" });
  });
});

describe("a session's state", () => {
  test("follows the CLI's own messages, in the CLI's names for modes", async () => {
    const { runner, fake, done } = started();
    const seen: string[] = [];
    runner.subscribe((state) => seen.push(`${state.status}/${state.permissionMode}`));
    fake().send({ type: "system", subtype: "init", permissionMode: "default", claude_code_version: "2.1.302" });
    fake().send({ type: "system", subtype: "session_state_changed", state: "running" });
    fake().send({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a" }, { task_id: "b" }] });
    fake().send({ type: "system", subtype: "status", status: null, permissionMode: "plan" });
    fake().send({ type: "system", subtype: "session_state_changed", state: "idle" });
    await Bun.sleep(5);
    expect(seen).toEqual(["idle/manual", "running/manual", "running/manual", "running/plan", "idle/plan"]);
    expect(runner.state()).toMatchObject({ backgroundTasks: 2, claudeCodeVersion: "2.1.302" });
    fake().end();
    await done;
    expect(runner.state().status).toBe("exited");
  });

  test("is running from a prompt or the first streamed byte to the result, and waiting while a call is held", async () => {
    const { runner, fake, done } = started();
    fake().send({ type: "system", subtype: "init", permissionMode: "auto", claude_code_version: "2.1.302" });
    await Bun.sleep(2);
    expect(runner.state().status).toBe("idle");
    runner.prompt("go");
    expect(runner.state().status).toBe("running");
    fake().send({ type: "result", subtype: "success" });
    await Bun.sleep(2);
    expect(runner.state().status).toBe("idle");
    fake().send({ type: "stream_event", event: { type: "message_start" } });
    await Bun.sleep(2);
    expect(runner.state().status).toBe("running");
    call(fake(), "Bash", {}, "toolu_1");
    expect(runner.state().status).toBe("requires-action");
    fake().end();
    await done;
    expect(runner.state().status).toBe("exited");
  });

  test("hands every streamed event on, with the subagent it belongs to when it has one", async () => {
    const { runner, fake, done } = started();
    const frames: unknown[] = [];
    runner.onStream((frame) => frames.push(frame));
    fake().send({ type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null });
    fake().send({ type: "stream_event", event: { type: "content_block_delta" }, parent_tool_use_id: "toolu_a" });
    await Bun.sleep(2);
    expect(frames).toEqual([
      { type: "stream", event: { type: "message_start" }, parentToolUseId: null },
      { type: "stream", event: { type: "content_block_delta" }, parentToolUseId: "toolu_a" },
    ]);
    fake().end();
    await done;
  });

  test("a first turn and later prompts go in as a person's own words", async () => {
    const { runner, fake, done } = started({ ...PLAN, firstTurn: "begin" });
    expect(runner.prompt("and then this")).toEqual({ ok: true });
    await Bun.sleep(5);
    expect(fake().received.map((message) => message.message.content)).toEqual(["begin", "and then this"]);
    expect(fake().received.every((message) => message.origin?.kind === "human")).toBe(true);
    await runner.stop();
    await done;
    expect(runner.prompt("too late")).toMatchObject({ ok: false, reason: "failed" });
  });
});

describe("a question", () => {
  test("is held until answered, then resolves the call with the SDK's answers", async () => {
    const { runner, fake, done } = started();
    const { result } = call(fake(), "AskUserQuestion", ask, "toolu_1");
    expect(runner.state().pending).toEqual([{ kind: "question", toolUseId: "toolu_1", questions: ask.questions, openedAt: 1000 }]);
    expect(runner.answer([{ question: "Which tree do you prefer?", chosen: [{ index: 1, label: "Birch" }], other: "" }]))
      .toEqual({ ok: true });
    expect(await result).toEqual({
      behavior: "allow",
      updatedInput: { questions: ask.questions, answers: { "Which tree do you prefer?": "Birch" } },
    });
    expect(runner.state().pending).toEqual([]);
    fake().end();
    await done;
  });

  test("refuses answers for another question, or a choice whose label moved, and keeps waiting", async () => {
    const { runner, fake, done } = started();
    expect(runner.answer([{ question: "Q", chosen: [], other: "x" }])).toMatchObject({ ok: false, reason: "no-dialog" });
    call(fake(), "AskUserQuestion", ask, "toolu_1");
    expect(runner.answer([{ question: "Which bush?", chosen: [], other: "x" }])).toMatchObject({ reason: "wrong-dialog" });
    expect(runner.answer([{ question: "Which tree do you prefer?", chosen: [{ index: 0, label: "Birch" }], other: "" }]))
      .toMatchObject({ reason: "wrong-option" });
    expect(runner.state().pending).toHaveLength(1);
    fake().end();
    await done;
  });

  test("an interrupted turn cancels it, and a session that ends denies what is left", async () => {
    const { runner, fake, done } = started();
    const first = call(fake(), "AskUserQuestion", ask, "toolu_1");
    first.abort.abort();
    expect(await first.result).toEqual({ behavior: "deny", message: "Cancelled." });
    const second = call(fake(), "AskUserQuestion", ask, "toolu_2");
    fake().end();
    await done;
    expect(await second.result).toMatchObject({ behavior: "deny" });
    expect(runner.state().pending).toEqual([]);
  });
});

describe("the answers the SDK takes", () => {
  const multi = [{ question: "Which?", header: "", multiSelect: true, options: [{ label: "A", description: "" }, { label: "B", description: "" }] }];

  test("join several choices and free text, in order", () => {
    expect(sdkAnswers(multi, [{ question: "Which?", chosen: [{ index: 0, label: "A" }, { index: 1, label: "B" }], other: " C " }]))
      .toEqual({ ok: true, answers: { "Which?": "A, B, C" } });
  });

  test("take free text alone, and refuse an empty answer", () => {
    expect(sdkAnswers(multi, [{ question: "Which?", chosen: [], other: "neither" }])).toEqual({ ok: true, answers: { "Which?": "neither" } });
    expect(sdkAnswers(multi, [{ question: "Which?", chosen: [], other: "  " }])).toMatchObject({ ok: false, refused: "wrong-option" });
  });
});

describe("an approval", () => {
  test("carries the CLI's own wording, and an allow passes the input through", async () => {
    const { runner, fake, done } = started();
    const input = { command: "rm -rf build" };
    const { result } = call(fake(), "Bash", input, "toolu_9", {
      title: "Claude wants to run rm -rf build",
      displayName: "Run command",
      decisionReason: "outside the allow list",
      defaultToNo: true,
    });
    expect(runner.state().pending).toEqual([{
      kind: "approval",
      toolUseId: "toolu_9",
      toolName: "Bash",
      input,
      title: "Claude wants to run rm -rf build",
      displayName: "Run command",
      decisionReason: "outside the allow list",
      defaultToNo: true,
      openedAt: 1000,
    }]);
    expect(runner.decide("toolu_9", true)).toEqual({ ok: true });
    expect(await result).toEqual({ behavior: "allow", updatedInput: input });
    expect(runner.decide("toolu_9", true)).toMatchObject({ ok: false, reason: "not-pending" });
    fake().end();
    await done;
  });

  test("a deny tells the model why, in the reader's words when there are some", async () => {
    const { runner, fake, done } = started();
    const plain = call(fake(), "Bash", {}, "toolu_1");
    const said = call(fake(), "Write", {}, "toolu_2");
    runner.decide("toolu_1", false);
    runner.decide("toolu_2", false, "use the scratch directory instead");
    expect(await plain.result).toEqual({ behavior: "deny", message: "The person denied this from the agent panel." });
    expect(await said.result).toEqual({ behavior: "deny", message: "use the scratch directory instead" });
    fake().end();
    await done;
  });

  test("an answer is not a decision, and a decision is not an answer", async () => {
    const { runner, fake, done } = started();
    call(fake(), "AskUserQuestion", ask, "toolu_q");
    expect(runner.decide("toolu_q", true)).toMatchObject({ ok: false, reason: "not-pending" });
    fake().end();
    await done;
  });
});

describe("the permission mode", () => {
  test("is set live, in the SDK's name, and bypass only when the launch allowed it", async () => {
    const { runner, fake, done } = started({ ...PLAN, allowBypass: false });
    await Bun.sleep(1);
    expect(await runner.setMode("manual")).toEqual({ ok: true });
    expect(fake().modes).toEqual(["default"]);
    expect(runner.state().permissionMode).toBe("manual");
    expect(await runner.setMode("bypassPermissions")).toMatchObject({ ok: false, reason: "invalid" });
    fake().end();
    await done;
    expect(await runner.setMode("plan")).toMatchObject({ ok: false, reason: "failed" });
  });
});

describe("stopping", () => {
  test("interrupts a turn in progress before closing the input", async () => {
    const { runner, fake, done } = started();
    fake().send({ type: "system", subtype: "session_state_changed", state: "running" });
    await Bun.sleep(5);
    await runner.stop();
    await done;
    expect(fake().interrupts).toBe(1);
  });
});
