import { describe, expect, test } from "bun:test";
import { sdkAnswers } from "@/claude-sdk/session/claudeSdkAnswers";
import type { RunnerCallback, RunnerRecord } from "@/claude-sdk/claudeSdkProtocol";
import { sdkModels, SdkSession } from "@/claude-sdk/session/claudeSdkSession";
import { parseSessionCommand } from "@/claude-sdk/session/claudeSdkCommands";

const SESSION = "11111111-2222-4333-8444-555555555555";

const message = (fields: Record<string, unknown> & { type: string }): RunnerRecord => ({ kind: "message", message: fields });
const called = (method: string, ...args: unknown[]): RunnerRecord => ({ kind: "called", method, args });

function callback(id: string, toolName: string, input: Record<string, unknown>, options: Record<string, unknown> = {}): RunnerCallback {
  return { id, toolName, input, options: { toolUseID: `toolu_${id}`, ...options }, openedAt: 1000 };
}

const ask = {
  questions: [{
    question: "Which tree do you prefer?",
    header: "Tree",
    multiSelect: false,
    options: [{ label: "Oak", description: "Sturdy" }, { label: "Birch", description: "White bark" }],
  }],
};

describe("a session's state", () => {
  test("follows the CLI's own messages, in the CLI's names for modes", () => {
    const session = new SdkSession(SESSION, true);
    expect(session.state().status).toBe("starting");
    session.fold(message({ type: "system", subtype: "init", permissionMode: "default", claude_code_version: "2.1.302", model: "claude-opus-5-5" }));
    expect(session.state()).toMatchObject({ status: "idle", permissionMode: "manual", claudeCodeVersion: "2.1.302", model: "claude-opus-5-5" });
    session.fold(message({ type: "system", subtype: "session_state_changed", state: "running" }));
    session.fold(message({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a" }, { task_id: "b" }] }));
    session.fold(message({ type: "system", subtype: "status", status: null, permissionMode: "plan" }));
    expect(session.state()).toMatchObject({ status: "running", permissionMode: "plan", backgroundTasks: 2 });
    session.fold({ kind: "ended" });
    expect(session.state().status).toBe("exited");
    session.fold({ kind: "input" });
    expect(session.state().status).toBe("exited");
  });

  test("is idle once the CLI answers a call, without waiting for the init of a first turn", () => {
    const session = new SdkSession(SESSION, true);
    session.answered();
    expect(session.state().status).toBe("idle");
    // A turn already under way, or a process that has gone, is not undone by a late answer.
    session.fold({ kind: "input" });
    session.answered();
    expect(session.state().status).toBe("running");
    session.fold({ kind: "ended" });
    session.answered();
    expect(session.state().status).toBe("exited");
  });

  test("is running from an input or the first streamed byte to the result, and waiting while a call is held", () => {
    const session = new SdkSession(SESSION, true);
    session.fold(message({ type: "system", subtype: "init", permissionMode: "auto" }));
    session.fold({ kind: "input" });
    expect(session.state().status).toBe("running");
    session.fold(message({ type: "result", subtype: "success" }));
    expect(session.state().status).toBe("idle");
    session.fold(message({ type: "stream_event", event: { type: "message_start" } }));
    expect(session.state().status).toBe("running");
    session.hold(callback("1", "Bash", {}));
    expect(session.state().status).toBe("requires-action");
    session.settled("1");
    expect(session.state().status).toBe("running");
  });

  test("hands each streamed event to the mirror, with the subagent it belongs to when it has one", () => {
    const session = new SdkSession(SESSION, true);
    expect(session.fold(message({ type: "stream_event", event: { type: "message_start" }, parent_tool_use_id: null })))
      .toEqual({ event: { type: "message_start" }, parentToolUseId: null });
    expect(session.fold(message({ type: "stream_event", event: { type: "content_block_delta" }, parent_tool_use_id: "toolu_a" })))
      .toEqual({ event: { type: "content_block_delta" }, parentToolUseId: "toolu_a" });
    expect(session.fold(message({ type: "assistant" }))).toBeNull();
  });

  test("is rebuilt from a replay in the order the runner kept it", () => {
    const session = new SdkSession(SESSION, false);
    for (const record of [
      message({ type: "system", subtype: "init", permissionMode: "auto", model: "claude-opus-5-5" }),
      called("setModel", "haiku"),
      called("applyFlagSettings", { effortLevel: "max", fastMode: true }),
      message({ type: "stream_event", event: { type: "message_stop" } }),
      message({ type: "result", subtype: "success" }),
    ]) session.fold(record);
    session.setModels(sdkModels([{ value: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "Haiku" }]));
    expect(session.state()).toMatchObject({ status: "idle", model: "haiku", effort: "max", allowBypass: false });
  });
});

describe("the choices a relaunch carries", () => {
  test("start as what the runner was launched with, and follow what is chosen since", () => {
    const session = new SdkSession(SESSION, true, { model: "haiku", effort: "high" });
    expect(session.state()).toMatchObject({ model: "haiku", effort: "high" });
    expect(session.choices()).toEqual({ model: "haiku", effort: "high" });
    session.fold(called("setModel", "opus"));
    session.fold(called("applyFlagSettings", { effortLevel: null }));
    expect(session.choices()).toEqual({ model: "opus" });
  });

  test("never take what the CLI reports as a choice, so a default is not pinned", () => {
    const session = new SdkSession(SESSION, true);
    session.fold(message({ type: "system", subtype: "init", permissionMode: "auto", model: "claude-opus-5-5", effort: "high" }));
    expect(session.state()).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    expect(session.choices()).toEqual({});
  });
});

describe("a prompt sent while a turn runs", () => {
  test("is held as queued until that turn's result, by when the CLI has taken it in", () => {
    const session = new SdkSession(SESSION, true);
    session.fold(message({ type: "system", subtype: "init", permissionMode: "auto" }));
    expect(session.busy()).toBe(false);
    session.fold({ kind: "input" });
    expect(session.busy()).toBe(true);
    session.queue("also this", 1, 5000);
    expect(session.state().queued).toEqual([{ id: "q1", text: "also this", images: 1, sentAt: 5000 }]);
    session.fold(message({ type: "result", subtype: "success" }));
    expect(session.state().queued).toEqual([]);
    session.queue("late", 0, 6000);
    session.fold({ kind: "ended" });
    expect(session.state().queued).toEqual([]);
  });
});

describe("before the first turn", () => {
  test("the mode is the one the runner launched in, until the CLI names its own", () => {
    const session = new SdkSession(SESSION, true, {}, "default");
    expect(session.state().permissionMode).toBe("manual");
    session.fold(message({ type: "system", subtype: "init", permissionMode: "plan" }));
    expect(session.state().permissionMode).toBe("plan");
    expect(new SdkSession(SESSION, true, {}, "sideways").state().permissionMode).toBeNull();
  });

  test("model and effort are what the CLI says it would send, under anything chosen or said since", () => {
    const session = new SdkSession(SESSION, true);
    expect(session.state()).toMatchObject({ model: null, effort: null });
    // Measured 2026-10-18: `getSettings()` with no turn run answers `applied` beside the settings files.
    session.setApplied({ effective: { env: {} }, sources: [], applied: { model: "claude-opus-5-5", effort: "high", ultracode: false } });
    expect(session.state()).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
    session.fold(called("applyFlagSettings", { effortLevel: "low" }));
    session.fold(message({ type: "system", subtype: "init", permissionMode: "auto", model: "claude-haiku-4-5" }));
    expect(session.state()).toMatchObject({ model: "claude-haiku-4-5", effort: "low" });
    const chosen = new SdkSession(SESSION, true, { model: "haiku" });
    chosen.setApplied({ applied: { model: "claude-opus-5-5", effort: "ultra" } });
    expect(chosen.state()).toMatchObject({ model: "haiku", effort: null });
  });
});

describe("the models and the effort", () => {
  test("a model choice reads as the full id its alias stands for, until the CLI names it", () => {
    const session = new SdkSession(SESSION, true);
    session.setModels(sdkModels([
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "", supportsEffort: true, supportedEffortLevels: ["low", "max", "ultra"] },
      { value: "haiku", resolvedModel: "claude-haiku-4-5", displayName: "Haiku", description: "" },
      { displayName: "no value" },
    ]));
    expect(session.state().models.map((entry) => entry.effortLevels)).toEqual([["low", "max"], undefined]);
    session.fold(called("setModel", "haiku"));
    expect(session.state().model).toBe("claude-haiku-4-5");
  });

  test("an effort chosen stands until the CLI names one, which is the better account", () => {
    const session = new SdkSession(SESSION, true);
    expect(session.plan({ type: "set-effort", effort: "max" }))
      .toEqual({ send: { type: "call", method: "applyFlagSettings", args: [{ effortLevel: "max" }] } });
    session.fold(called("applyFlagSettings", { effortLevel: "max" }));
    expect(session.state().effort).toBe("max");
    session.fold(message({ type: "system", subtype: "init", permissionMode: "auto" }));
    expect(session.state().effort).toBe("max");
    session.fold(message({ type: "system", subtype: "init", permissionMode: "auto", effort: "high" }));
    expect(session.state().effort).toBe("high");
  });
});

describe("a question", () => {
  test("is shown from the call, and an answer that fits settles it with the SDK's answers", () => {
    const session = new SdkSession(SESSION, true);
    expect(session.hold(callback("1", "AskUserQuestion", ask))).toBeNull();
    expect(session.state().pending).toEqual([{ kind: "question", toolUseId: "toolu_1", questions: ask.questions, openedAt: 1000 }]);
    expect(session.plan({ type: "answer", answers: [{ question: "Which tree do you prefer?", chosen: [{ index: 1, label: "Birch" }], other: "" }] }))
      .toEqual({
        send: {
          type: "settle",
          callback: "1",
          result: { behavior: "allow", updatedInput: { questions: ask.questions, answers: { "Which tree do you prefer?": "Birch" } } },
        },
      });
  });

  test("refuses answers when nothing waits, for another question, or a choice whose label moved", () => {
    const session = new SdkSession(SESSION, true);
    expect(session.plan({ type: "answer", answers: [{ question: "Q", chosen: [], other: "x" }] })).toMatchObject({ refuse: { reason: "no-dialog" } });
    session.hold(callback("1", "AskUserQuestion", ask));
    expect(session.plan({ type: "answer", answers: [{ question: "Which bush?", chosen: [], other: "x" }] }))
      .toMatchObject({ refuse: { reason: "wrong-dialog" } });
    expect(session.plan({ type: "answer", answers: [{ question: "Which tree do you prefer?", chosen: [{ index: 0, label: "Birch" }], other: "" }] }))
      .toMatchObject({ refuse: { reason: "wrong-option" } });
  });

  test("one the panel cannot draw is denied at once rather than shown", () => {
    const session = new SdkSession(SESSION, true);
    expect(session.hold(callback("1", "AskUserQuestion", { questions: "?" }))).toMatchObject({ behavior: "deny" });
    expect(session.state().pending).toEqual([]);
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
  test("carries the CLI's own wording, and an allow passes the input through", () => {
    const session = new SdkSession(SESSION, true);
    const input = { command: "rm -rf build" };
    session.hold(callback("9", "Bash", input, {
      title: "Claude wants to run rm -rf build",
      displayName: "Run command",
      decisionReason: "outside the allow list",
      defaultToNo: true,
      requestId: "r9",
    }));
    expect(session.state().pending).toEqual([{
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
    expect(session.plan({ type: "decide", toolUseId: "toolu_9", allow: true }))
      .toEqual({ send: { type: "settle", callback: "9", result: { behavior: "allow", updatedInput: input } } });
    session.settled("9");
    expect(session.plan({ type: "decide", toolUseId: "toolu_9", allow: true })).toMatchObject({ refuse: { reason: "not-pending" } });
  });

  test("a deny tells the model why, in the reader's words when there are some", () => {
    const session = new SdkSession(SESSION, true);
    session.hold(callback("1", "Bash", {}));
    expect(session.plan({ type: "decide", toolUseId: "toolu_1", allow: false }))
      .toMatchObject({ send: { result: { behavior: "deny", message: "The person denied this from the agent panel." } } });
    expect(session.plan({ type: "decide", toolUseId: "toolu_1", allow: false, message: "use the scratch directory instead" }))
      .toMatchObject({ send: { result: { behavior: "deny", message: "use the scratch directory instead" } } });
  });

  test("an answer is not a decision, and a decision is not an answer", () => {
    const session = new SdkSession(SESSION, true);
    session.hold(callback("q", "AskUserQuestion", ask));
    expect(session.plan({ type: "decide", toolUseId: "toolu_q", allow: true })).toMatchObject({ refuse: { reason: "not-pending" } });
  });
});

describe("what the runner is sent", () => {
  test("a mode in the SDK's name, and bypass only when the launch allowed it", () => {
    expect(new SdkSession(SESSION, false).plan({ type: "set-mode", mode: "manual" }))
      .toEqual({ send: { type: "call", method: "setPermissionMode", args: ["default"] } });
    expect(new SdkSession(SESSION, false).plan({ type: "set-mode", mode: "bypassPermissions" })).toMatchObject({ refuse: { reason: "invalid" } });
    const session = new SdkSession(SESSION, true);
    session.fold(called("setPermissionMode", "default"));
    expect(session.state().permissionMode).toBe("manual");
  });

  test("a prompt as a person's own words, images ahead of them, and none once the session has ended", () => {
    const session = new SdkSession(SESSION, true);
    expect(session.plan({ type: "prompt", text: "what is this?", images: [{ mediaType: "image/png", data: "iVBORw0K" }] })).toEqual({
      send: {
        type: "input",
        message: {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
              { type: "text", text: "what is this?" },
            ],
          },
          parent_tool_use_id: null,
          origin: { kind: "human" },
        },
      },
    });
    session.fold({ kind: "ended" });
    expect(session.plan({ type: "prompt", text: "too late" })).toMatchObject({ refuse: { reason: "failed" } });
  });

  test("a rename as the CLI's own control request for this session", () => {
    expect(new SdkSession(SESSION, true).plan({ type: "rename", title: "Garden notes" }))
      .toEqual({ send: { type: "call", method: "renameSession", args: ["Garden notes", SESSION] } });
  });
});

describe("a command a request describes", () => {
  test("is checked field by field", () => {
    expect(parseSessionCommand({ type: "set-model", model: "haiku" })).toEqual({ type: "set-model", model: "haiku" });
    expect(parseSessionCommand({ type: "set-model", model: "opus; rm -rf" })).toBeNull();
    expect(parseSessionCommand({ type: "set-effort", effort: "ultra" })).toBeNull();
    expect(parseSessionCommand({ type: "prompt", text: "  " })).toBeNull();
    expect(parseSessionCommand({ type: "prompt", text: "x", images: [{ mediaType: "image/heic", data: "AAAA" }] })).toBeNull();
    expect(parseSessionCommand({ type: "rename", title: "two\nlines" })).toBeNull();
    expect(parseSessionCommand({ type: "launch" })).toBeNull();
  });
});
