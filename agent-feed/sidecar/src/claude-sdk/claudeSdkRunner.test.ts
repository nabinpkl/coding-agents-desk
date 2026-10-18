import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { FakeQuery } from "@/claude-sdk/claudeSdkHarness";
import { ClaudeSdkRunner, type RunnerEvent, type RunnerPlan } from "@/claude-sdk/claudeSdkRunner";
import { planFromArguments } from "@/claude-sdk/claudeSdkRunnerMain";
import { RUNNER_SOURCE_FILES, runnerBuild } from "@/claude-sdk/claudeSdkProtocol";

const PLAN: RunnerPlan = {
  sessionId: "11111111-2222-4333-8444-555555555555",
  cwd: "/tmp/project",
  name: "Probe session",
  start: "new",
  permissionMode: "auto",
  allowBypass: true,
  pluginDirectories: ["/mods/prompt-guard"],
  claudePath: "/usr/local/bin/claude",
  choices: {},
};

function started(plan: RunnerPlan = PLAN) {
  let fake!: FakeQuery;
  const runner = new ClaudeSdkRunner(
    plan,
    ({ prompt, options }) => (fake = new FakeQuery(options, prompt)),
    () => 1000,
  );
  const done = runner.run(() => {});
  return { runner, fake: () => fake, done };
}

function call(fake: FakeQuery, toolName: string, input: Record<string, unknown>, toolUseID: string, extra = {}) {
  const abort = new AbortController();
  const result = fake.canUseTool(toolName, input, {
    signal: abort.signal,
    toolUseID,
    requestId: `req-${toolUseID}`,
    ...extra,
  }) as Promise<PermissionResult>;
  return { result, abort };
}

describe("the options a plan comes to", () => {
  test("a new session at its id, through the installed CLI, in the launch mode, with summaries on", () => {
    const options = new ClaudeSdkRunner(PLAN, () => {
      throw new Error("unused");
    }).options();
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

  test("a resume names the session to resume, keeps its name, and takes the mode in the SDK's spelling", () => {
    const options = new ClaudeSdkRunner(
      { ...PLAN, start: "resume", permissionMode: "default", allowBypass: false },
      () => {
        throw new Error("unused");
      },
    ).options();
    expect(options.resume).toBe(PLAN.sessionId);
    expect(options.sessionId).toBeUndefined();
    expect(options.permissionMode).toBe("default");
    expect(options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(options.extraArgs).toEqual({ name: "Probe session" });
  });
});

describe("the choices a launch carries", () => {
  test("start the query on the model and effort the session had chosen, and nothing when none", () => {
    const options = new ClaudeSdkRunner({ ...PLAN, choices: { model: "haiku", effort: "max" } }, () => {
      throw new Error("unused");
    }).options();
    expect(options).toMatchObject({ model: "haiku", effort: "max" });
    const plain = new ClaudeSdkRunner(PLAN, () => {
      throw new Error("unused");
    }).options();
    expect(plain.model).toBeUndefined();
    expect(plain.effort).toBeUndefined();
  });

  test("are read off the command line, and refused when malformed", async () => {
    const base = [
      "--session",
      PLAN.sessionId,
      "--cwd",
      "/tmp",
      "--name",
      "n",
      "--start",
      "resume",
      "--permission-mode",
      "default",
      "--claude",
      "/c",
      "--socket-dir",
      "/s",
    ];
    expect((await planFromArguments([...base, "--model", "haiku", "--effort", "xhigh"])).plan.choices).toEqual({
      model: "haiku",
      effort: "xhigh",
    });
    expect((await planFromArguments(base)).plan.choices).toEqual({});
    expect(planFromArguments([...base, "--effort", "ultra"])).rejects.toThrow("--effort");
    expect(planFromArguments([...base, "--model", "opus; rm -rf"])).rejects.toThrow("--model");
  });
});

describe("a fork's options", () => {
  test("open the source's conversation as a new session at the fork's id, cut where it was asked", () => {
    const options = new ClaudeSdkRunner(
      { ...PLAN, start: "fork", forkFrom: "source-session", resumeAt: "uuid-before" },
      () => {
        throw new Error("unused");
      },
    ).options();
    expect(options).toMatchObject({
      resume: "source-session",
      forkSession: true,
      sessionId: PLAN.sessionId,
      resumeSessionAt: "uuid-before",
    });
  });
});

describe("what the runner keeps", () => {
  test("the latest message of each type and subtype, in the order each was last replaced", async () => {
    const { runner, fake, done } = started();
    fake().send({ type: "system", subtype: "init", model: "a" });
    fake().send({ type: "stream_event", event: { type: "message_start" } });
    fake().send({ type: "system", subtype: "status", permissionMode: "plan" });
    fake().send({ type: "system", subtype: "init", model: "b" });
    await Bun.sleep(5);
    expect(runner.snapshot().records).toEqual([
      { kind: "message", message: { type: "stream_event", event: { type: "message_start" } } },
      { kind: "message", message: { type: "system", subtype: "status", permissionMode: "plan" } },
      { kind: "message", message: { type: "system", subtype: "init", model: "b" } },
    ]);
    fake().end();
    await done;
    expect(runner.snapshot().records.at(-1)).toEqual({ kind: "ended" });
  });

  test("tells its listeners every record and callback as it happens", async () => {
    const { runner, fake, done } = started();
    const events: RunnerEvent["type"][] = [];
    runner.subscribe((event) => events.push(event.type));
    fake().send({ type: "result", subtype: "success" });
    await Bun.sleep(2);
    void call(fake(), "Bash", {}, "toolu_1");
    runner.resolve(runner.snapshot().callbacks[0]!.id, { behavior: "allow", updatedInput: {} });
    expect(events).toEqual(["record", "callback", "settled"]);
    fake().end();
    await done;
  });
});

describe("a call", () => {
  test("runs the named method on the query with the arguments sent, and keeps it", async () => {
    const { runner, fake, done } = started();
    await Bun.sleep(1);
    expect(await runner.call("setModel", ["haiku"])).toEqual({ ok: true, value: null });
    expect(fake().models).toEqual(["haiku"]);
    const listed = await runner.call("supportedModels", []);
    expect(listed.ok && (listed.value as { value: string }[]).map((entry) => entry.value)).toEqual(["opus", "haiku"]);
    expect(runner.snapshot().records).toContainEqual({ kind: "called", method: "setModel", args: ["haiku"] });
    fake().end();
    await done;
  });

  test("layers the calls of a method that takes one settings object, as the flag layer does", async () => {
    const { runner, fake, done } = started();
    await Bun.sleep(1);
    await runner.call("applyFlagSettings", [{ effortLevel: "high" }]);
    await runner.call("applyFlagSettings", [{ fastMode: true }]);
    expect(fake().flagSettings).toEqual([{ effortLevel: "high" }, { fastMode: true }]);
    expect(runner.snapshot().records).toEqual([
      { kind: "called", method: "applyFlagSettings", args: [{ effortLevel: "high", fastMode: true }] },
    ]);
    fake().end();
    await done;
  });

  test("says so for a method the SDK has not, or one that throws, and keeps neither", async () => {
    const { runner, fake, done } = started();
    await Bun.sleep(1);
    expect(await runner.call("renameSessionLater", [])).toEqual({
      ok: false,
      message: "this SDK has no renameSessionLater",
    });
    (fake() as unknown as { setModel: () => Promise<void> }).setModel = async () => {
      throw new Error("no such model");
    };
    expect(await runner.call("setModel", ["x"])).toEqual({ ok: false, message: "no such model" });
    expect(runner.snapshot().records).toEqual([]);
    fake().end();
    await done;
    expect(await runner.call("setModel", ["opus"])).toEqual({ ok: false, message: "the session is not running" });
  });
});

describe("the session's input", () => {
  test("a first turn and later inputs go in as they were built, and none after the end", async () => {
    const { runner, fake, done } = started({ ...PLAN, firstTurn: "begin" });
    const later = {
      type: "user" as const,
      message: { role: "user" as const, content: "and then this" },
      parent_tool_use_id: null,
    };
    expect(runner.input(later)).toEqual({ ok: true, value: null });
    await Bun.sleep(5);
    expect(fake().received.map((message) => message.message.content)).toEqual(["begin", "and then this"]);
    expect(fake().received[0]!.origin?.kind).toBe("human");
    expect(runner.snapshot().records).toEqual([{ kind: "input" }]);
    await runner.stop();
    await done;
    expect(runner.input(later)).toMatchObject({ ok: false });
  });
});

describe("a permission callback", () => {
  test("is held with the CLI's wording until resolved, and resolves with what the sidecar sent", async () => {
    const { runner, fake, done } = started();
    const input = { command: "rm -rf build" };
    const { result } = call(fake(), "Bash", input, "toolu_9", {
      title: "Claude wants to run rm -rf build",
      defaultToNo: true,
    });
    const [held] = runner.snapshot().callbacks;
    expect(held).toEqual({
      id: "cb1",
      toolName: "Bash",
      input,
      options: {
        toolUseID: "toolu_9",
        requestId: "req-toolu_9",
        title: "Claude wants to run rm -rf build",
        defaultToNo: true,
      },
      openedAt: 1000,
    });
    expect(runner.resolve("cb1", { behavior: "deny", message: "not now" })).toEqual({ ok: true, value: null });
    expect(await result).toEqual({ behavior: "deny", message: "not now" });
    expect(runner.resolve("cb1", { behavior: "allow", updatedInput: input })).toMatchObject({ ok: false });
    expect(runner.snapshot().callbacks).toEqual([]);
    fake().end();
    await done;
  });

  test("an interrupted turn cancels it, and a session that ends denies what is left", async () => {
    const { runner, fake, done } = started();
    const first = call(fake(), "AskUserQuestion", { questions: [] }, "toolu_1");
    first.abort.abort();
    expect(await first.result).toEqual({ behavior: "deny", message: "Cancelled." });
    const second = call(fake(), "Bash", {}, "toolu_2");
    fake().end();
    await done;
    expect(await second.result).toEqual({ behavior: "deny", message: "The session ended." });
    expect(runner.snapshot().callbacks).toEqual([]);
  });
});

describe("the runner's build", () => {
  test("names the SDK and hashes every file of ours the runner process loads", () => {
    expect(runnerBuild()).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{16}$/);
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of RUNNER_SOURCE_FILES) {
      const source = readFileSync(join(here, file), "utf8");
      // Only a value import loads a module; a type import is gone once the file is transpiled.
      const loaded = [...source.matchAll(/^import (?!type )[^;]*?from "([^"]+)";/gms)].map((match) => match[1]!);
      for (const specifier of loaded) {
        expect(specifier.startsWith("@agentdesk/")).toBe(false);
        if (specifier.startsWith("@/")) {
          expect(RUNNER_SOURCE_FILES as readonly string[]).toContain(`${specifier.slice("@/claude-sdk/".length)}.ts`);
        }
      }
    }
  });
});
