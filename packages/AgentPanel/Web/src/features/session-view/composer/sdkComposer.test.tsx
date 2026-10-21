/**
 * A Claude session run through the Agent SDK (ADR-0143), as its composer handles it: the runner
 * owns the band before anything else, Send and Stop and the mode chip go to the runner, and the
 * question and approvals waiting in the runner are what the band draws.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DISCONNECTED_CLAUDE_SDK_STATE, type ClaudeSdkSessionState } from "@agentdesk/agent-feed-wire";
import { composerActions } from "@/features/session-view/composer/sessionComposerActions";
import { compactControl, submitComposer } from "@/features/session-view/composer/sessionComposerSubmit";
import { composerCaption, composerEditor } from "@/features/session-view/composer/sessionComposerEditor";
import { composerTransport, type ComposerModel } from "@/features/session-view/composer/sessionComposerModel";
import {
  currentSdkModel,
  sdkEffortChoice,
  sdkModelRows,
  type SdkSessionHandle,
} from "@/features/cli-input/useSdkSession";
import { runnerQuestion, sdkQuestionReasonText } from "@/features/session-view/composer/question/useQuestionMirror";
import { approvalDetail, SdkApprovalRequests } from "@/features/session-view/composer/question/SdkApprovalRequests";

const LIVE: ClaudeSdkSessionState = {
  connected: true,
  status: "idle",
  permissionMode: "auto",
  allowBypass: true,
  pending: [],
  backgroundTasks: 0,
  claudeCodeVersion: "2.1.302",
  claudeCodeNeeded: null,
  model: "claude-opus-5-5",
  models: [
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "" },
    {
      value: "opus",
      resolvedModel: "claude-opus-5-5",
      displayName: "Opus",
      description: "",
      effortLevels: ["low", "medium", "high", "max"],
    },
    { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku", description: "" },
  ],
  queued: [],
  effort: null,
  suggestion: null,
};

function handle(
  state: Partial<ClaudeSdkSessionState> = {},
  overrides: Partial<SdkSessionHandle> = {},
): SdkSessionHandle {
  return {
    state: { ...LIVE, ...state },
    pending: false,
    error: null,
    send: vi.fn(async () => true),
    interrupt: vi.fn(async () => true),
    decide: vi.fn(async () => true),
    choosePermissionMode: vi.fn(async () => true),
    setModel: vi.fn(async () => {}),
    setEffort: vi.fn(async () => {}),
    questions: { answerTmuxQuestion: vi.fn(), pointTmuxQuestion: vi.fn() },
    ...overrides,
  };
}

function sdkModel(session: SdkSessionHandle = handle(), overrides: Partial<ComposerModel> = {}): ComposerModel {
  return {
    session: { source: "claude", sessionId: "c1" },
    isClaude: true,
    sdkBand: true,
    sdkSession: session,
    tmuxBand: false,
    cliSessionBand: false,
    agentTerminalBand: false,
    windowBand: false,
    transport: { kind: "sdk-session" },
    editorValue: "hello",
    localDraft: "hello",
    unavailable: !session.state.connected,
    deliveryPending: false,
    pending: false,
    setDeliveryPending: vi.fn(),
    setDeliveryError: vi.fn(),
    setLocalDraft: vi.fn(),
    tmuxComposer: { pending: false, reason: null, permissionMode: null } as never,
    sendAttachments: attachments(),
    ...overrides,
  } as ComposerModel;
}

/** A band's held images: none unless a test hands some over. */
function attachments(images: { id: string }[] = []) {
  return {
    images,
    attach: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    toWire: vi.fn(async (held: { id: string }[]) =>
      held.map((image) => ({ data: `b64-${image.id}`, mime: "image/png", name: `${image.id}.png` })),
    ),
  } as unknown as ComposerModel["sendAttachments"];
}

describe("which surface owns the composer", () => {
  const none = {
    mirrored: false,
    terminalCandidate: false,
    windowCandidate: false,
    windowRefused: false,
    agentTerminal: null,
  };

  it("is the runner for an SDK session, ahead of a pane or a window", () => {
    expect(composerTransport({ ...none, sdkCandidate: true, mirrored: true, windowCandidate: true }).kind).toBe(
      "sdk-session",
    );
  });

  it("keeps the old order for everything else", () => {
    expect(composerTransport({ ...none, sdkCandidate: false, mirrored: true }).kind).toBe("tmux-composer");
    expect(composerTransport({ ...none, sdkCandidate: false, terminalCandidate: true }).kind).toBe("cli-session");
    expect(composerTransport({ ...none, sdkCandidate: false, windowCandidate: true }).kind).toBe("window");
    expect(composerTransport({ ...none, sdkCandidate: false }).kind).toBe("agent-session");
  });
});

describe("the SDK band's actions", () => {
  it("sends while idle, through the runner, and empties the draft once it is taken", async () => {
    const m = sdkModel();
    expect(composerActions(m).find((action) => action.placement === "field")?.key).toBe("send-sdk");
    await submitComposer(m, "next");
    expect(m.sdkSession.send).toHaveBeenCalledWith("hello", undefined);
    expect(m.setLocalDraft).toHaveBeenCalledWith("");
  });

  it("sends the images held in the band with the turn, and lets go of them once it is taken", async () => {
    const held = attachments([{ id: "shot" }]);
    const m = sdkModel(handle(), { sendAttachments: held });
    await submitComposer(m, "next");
    expect(m.sdkSession.send).toHaveBeenCalledWith("hello", [
      { data: "b64-shot", mime: "image/png", name: "shot.png" },
    ]);
    expect(held.clear).toHaveBeenCalled();
    expect(composerEditor(m).onFiles).toBe(held.attach);
  });

  it("does not put the band's images on /compact", async () => {
    const held = attachments([{ id: "shot" }]);
    const m = sdkModel(handle(), { editorValue: "", sendAttachments: held });
    await compactControl(m)!.run();
    expect(m.sdkSession.send).toHaveBeenCalledWith("/compact", undefined);
    expect(held.clear).not.toHaveBeenCalled();
  });

  it("keeps the draft when the runner refuses it", async () => {
    const m = sdkModel(handle({}, { send: vi.fn(async () => false) }));
    await submitComposer(m, "next");
    expect(m.setLocalDraft).not.toHaveBeenCalled();
  });

  it("stops the turn while one runs or waits on the reader", () => {
    for (const status of ["running", "requires-action"] as const) {
      const m = sdkModel(handle({ status }));
      const stop = composerActions(m).find((action) => action.placement === "field")!;
      expect(stop.key).toBe("stop-sdk");
      stop.onClick!();
      expect(m.sdkSession.interrupt).toHaveBeenCalled();
    }
  });

  it("shows the runner's mode and sets the one chosen from its menu, and cannot while no runner answers", () => {
    const m = sdkModel(handle({ permissionMode: "plan" }));
    const chip = composerActions(m).find((action) => action.key === "permission-mode")!;
    expect(chip.ariaLabel).toBe("Permission mode Plan, choose another");
    expect(chip.menu?.value).toBe("plan");
    expect(chip.menu?.choices.map((choice) => choice.value)).toEqual([
      "plan",
      "manual",
      "acceptEdits",
      "auto",
      "bypassPermissions",
    ]);
    chip.menu!.onChoose("acceptEdits");
    expect(m.sdkSession.choosePermissionMode).toHaveBeenCalledWith("acceptEdits");
    const gone = sdkModel(handle({ ...DISCONNECTED_CLAUDE_SDK_STATE }));
    expect(composerActions(gone).find((action) => action.key === "permission-mode")?.disabled).toBe(true);
  });

  it("draws the mode's icon always, and its name only where the footer is wide enough", () => {
    const chip = composerActions(sdkModel(handle({ permissionMode: "bypassPermissions" }))).find(
      (action) => action.key === "permission-mode",
    )!;
    const { container } = render(<>{chip.icon}</>);
    expect(container.querySelector("svg")).toBeTruthy();
    const name = screen.getByText("Bypass");
    expect(name.className).toContain("hidden");
    expect(name.className).toContain("@[420px]:inline");
  });

  it("offers the current model's effort levels in the picker, and sets the one chosen", async () => {
    const session = handle({ effort: "high" });
    const choice = sdkEffortChoice(session)!;
    expect(choice.levels).toEqual(["low", "medium", "high", "max"]);
    expect(choice.current).toBe("high");
    await choice.onChoose("max");
    expect(session.setEffort).toHaveBeenCalledWith("max");
    expect(sdkEffortChoice(handle({ model: "claude-haiku-5-5" }))).toBeUndefined();
  });

  it("compacts by sending /compact as a turn, and not over a draft or without a runner", async () => {
    const m = sdkModel(handle(), { editorValue: "" });
    await compactControl(m)!.run();
    expect(m.sdkSession.send).toHaveBeenCalledWith("/compact", undefined);
    expect(compactControl(sdkModel())!.blocked).toBe("Send or clear the draft in the composer first.");
    expect(compactControl(sdkModel(handle({ connected: false }), { editorValue: "" }))!.blocked).toBe(
      "This session is not running.",
    );
  });

  it("offers Claude's guess at the next prompt in the empty field, and Tab puts it there to edit", () => {
    const m = sdkModel(handle({ suggestion: "run the tests" }), { localDraft: "" });
    const editor = composerEditor(m);
    expect(editor.placeholder).toBe("run the tests");
    editor.onAcceptHint!();
    expect(m.setLocalDraft).toHaveBeenCalledWith("run the tests");
    expect(m.sdkSession.send).not.toHaveBeenCalled();
  });

  it("offers no guess over a draft, during a turn, or without a runner, so Tab moves focus there", () => {
    for (const m of [
      sdkModel(handle({ suggestion: "run the tests" })),
      sdkModel(handle({ suggestion: "run the tests", status: "running" }), { localDraft: "" }),
      sdkModel(handle({ suggestion: "run the tests", connected: false }), { localDraft: "" }),
    ]) {
      const editor = composerEditor(m);
      expect(editor.placeholder).not.toBe("run the tests");
      expect(editor.onAcceptHint).toBeUndefined();
    }
  });

  it("offers no guess at all on a surface that hides them, so the field and Tab are as if none came", () => {
    const m = sdkModel(handle({ suggestion: "run the tests" }), { localDraft: "" });
    const editor = composerEditor(m, { promptSuggestions: false });
    expect(editor.placeholder).toBe("Message Claude\u2026");
    expect(editor.onAcceptHint).toBeUndefined();
  });

  it("says when there is no runner, and says the runner's refusal", () => {
    const gone = sdkModel(handle({ connected: false }));
    expect(composerEditor(gone).placeholder).toBe("This session is not running");
    expect(composerCaption(gone)).toEqual({ caption: "This session is not running.", captionIsError: false });
    expect(composerCaption(sdkModel(handle({}, { error: "That request is no longer waiting." })))).toEqual({
      caption: "That request is no longer waiting.",
      captionIsError: true,
    });
  });

  it("says when the session's Claude Code is older than the Agent SDK is built for, and nothing otherwise", () => {
    const behind = composerCaption(sdkModel(handle({ claudeCodeVersion: "2.1.200", claudeCodeNeeded: "2.1.302" })));
    expect(behind.captionIsError).toBe(true);
    expect(behind.caption).toBe(
      "This session runs Claude Code 2.1.200, older than the 2.1.302 the panel's Agent SDK is built for. Update Claude Code, and the session moves to it once idle.",
    );
    expect(composerCaption(sdkModel())).toEqual({ caption: null, captionIsError: false });
    // A refusal from the runner is the more urgent line.
    expect(
      composerCaption(sdkModel(handle({ claudeCodeVersion: "2.1.200", claudeCodeNeeded: "2.1.302" }, { error: "No." })))
        .caption,
    ).toBe("No.");
  });
});

describe("moving a session between the terminal and the SDK", () => {
  const switcher = () => ({ pending: false, error: null, switchTo: vi.fn(async () => {}) });

  it("offers the SDK to a terminal session and the terminal to a live SDK one", () => {
    const toSdk = sdkModel(handle(), { sdkBand: false, runMode: "terminal", runModeSwitch: switcher() });
    composerActions(toSdk).find((action) => action.key === "switch-run-mode")!.onClick!();
    expect(toSdk.runModeSwitch.switchTo).toHaveBeenCalledWith("sdk");
    const toTerminal = sdkModel(handle(), { runMode: "sdk", runModeSwitch: switcher() });
    composerActions(toTerminal).find((action) => action.key === "switch-run-mode")!.onClick!();
    expect(toTerminal.runModeSwitch.switchTo).toHaveBeenCalledWith("terminal");
  });

  it("shows the SDK toggle on, in the active colour, only while the session runs through the SDK", () => {
    const toggle = (runMode: "sdk" | "terminal") =>
      composerActions(sdkModel(handle(), { sdkBand: runMode === "sdk", runMode, runModeSwitch: switcher() })).find(
        (action) => action.key === "switch-run-mode",
      )!;
    expect(toggle("sdk").pressed).toBe(true);
    expect(toggle("sdk").className).toContain("text-primary");
    expect(toggle("terminal").pressed).toBe(false);
    expect(toggle("terminal").className).not.toContain("text-primary");
  });

  it("offers nothing where neither mode is running", () => {
    expect(
      composerActions(sdkModel(handle(), { runMode: null, runModeSwitch: switcher() })).some(
        (action) => action.key === "switch-run-mode",
      ),
    ).toBe(false);
    expect(
      composerActions(sdkModel(handle({ connected: false }), { runMode: "sdk", runModeSwitch: switcher() })).some(
        (action) => action.key === "switch-run-mode",
      ),
    ).toBe(false);
  });

  it("puts a refusal in the caption, and two processes above everything", () => {
    expect(
      composerCaption(
        sdkModel(handle(), { runModeSwitch: { ...switcher(), error: "Not switched: a turn is running." } }),
      ),
    ).toEqual({ caption: "Not switched: a turn is running.", captionIsError: true });
    const forked = composerCaption(
      sdkModel(handle(), { liveProcesses: 2, runModeSwitch: { ...switcher(), error: "x" } }),
    );
    expect(forked.captionIsError).toBe(true);
    expect(forked.caption).toMatch(/^2 processes are running this session/);
  });
});

describe("the model", () => {
  it("shows the model the session answers with and opens the picker the way /model does", () => {
    const onRunSlash = vi.fn(async () => {});
    const m = sdkModel(handle(), { onRunSlash });
    const chip = composerActions(m).find((action) => action.key === "switch-model")!;
    expect(chip.ariaLabel).toBe("Switch model, currently Opus");
    chip.onClick!();
    expect(onRunSlash).toHaveBeenCalledWith("model", "");
  });

  it("offers no switch until the runner has listed what it can switch to", () => {
    expect(composerActions(sdkModel(handle({ models: [] }))).some((action) => action.key === "switch-model")).toBe(
      false,
    );
  });

  it("matches the current model by its full id without taking the default row for it", () => {
    expect(currentSdkModel(LIVE)?.value).toBe("opus");
    expect(currentSdkModel({ ...LIVE, model: "haiku" })?.value).toBe("haiku");
    expect(currentSdkModel({ ...LIVE, model: null })).toBeNull();
    expect(sdkModelRows({ ...LIVE, models: [] })).toBeNull();
    expect(sdkModelRows(LIVE)?.[1]).toEqual({
      providerID: "claude",
      modelID: "opus",
      name: "Opus",
      contextLimit: null,
      inputCost: null,
      outputCost: null,
    });
  });
});

describe("the mode menu", () => {
  it("offers bypass only to a runner started allowing it, and says why otherwise", () => {
    const bypass = (allowBypass: boolean) =>
      composerActions(sdkModel(handle({ allowBypass })))
        .find((action) => action.key === "permission-mode")!
        .menu!.choices.find((choice) => choice.value === "bypassPermissions")!;
    expect(bypass(true).unavailable).toBeUndefined();
    expect(bypass(false).unavailable).toBe("This session was started without bypass.");
  });
});

describe("the runner's question", () => {
  it("is drawn from the call the runner holds, by its tool-use id", () => {
    const shown = runnerQuestion({
      ...LIVE,
      pending: [
        {
          kind: "question",
          toolUseId: "toolu_1",
          openedAt: 1,
          questions: [
            {
              question: "Which tree?",
              header: "Tree",
              multiSelect: false,
              options: [{ label: "Oak", description: "" }],
            },
          ],
        },
      ],
    });
    expect(shown).toEqual({
      callId: "toolu_1",
      questions: [{ question: "Which tree?", header: "Tree", multiSelect: false, options: [{ label: "Oak" }] }],
    });
    expect(runnerQuestion(LIVE)).toBeNull();
  });

  it("is refused in words that do not mention a terminal", () => {
    for (const reason of [
      "no-pane",
      "tmux-unavailable",
      "no-dialog",
      "wrong-dialog",
      "wrong-option",
      "pane-stalled",
      "still-open",
    ] as const) {
      expect(sdkQuestionReasonText(reason)).not.toMatch(/terminal|pane/);
    }
  });
});

describe("an approval", () => {
  const approval = {
    kind: "approval" as const,
    toolUseId: "toolu_9",
    toolName: "Bash",
    input: { command: "rm -rf build", description: "clean" },
    title: "Claude wants to run rm -rf build",
    decisionReason: "outside the allow list",
    openedAt: 1,
  };

  it("shows the CLI's own sentence and the command, and answers with the reader's choice", () => {
    const session = handle({ pending: [approval] });
    render(<SdkApprovalRequests session={session} />);
    expect(screen.getByText("Claude wants to run rm -rf build")).toBeTruthy();
    expect(screen.getByText("rm -rf build")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(session.decide).toHaveBeenCalledWith("toolu_9", true);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(session.decide).toHaveBeenCalledWith("toolu_9", false);
  });

  it("is not drawn when nothing waits, and shows a whole input it has no field for", () => {
    const { container } = render(<SdkApprovalRequests session={handle()} />);
    expect(container.textContent).toBe("");
    expect(approvalDetail({ todos: [1] })).toEqual({ headline: null, rest: JSON.stringify({ todos: [1] }, null, 2) });
  });

  it("never shows the telling field alone: a Write's content is shown under its path", () => {
    const write = { file_path: "/etc/hosts", content: "0.0.0.0 example.com" };
    expect(approvalDetail(write)).toEqual({
      headline: "/etc/hosts",
      rest: JSON.stringify({ content: "0.0.0.0 example.com" }, null, 2),
    });
    render(<SdkApprovalRequests session={handle({ pending: [{ ...approval, toolName: "Write", input: write }] })} />);
    expect(screen.getByText(/0\.0\.0\.0 example\.com/)).toBeTruthy();
    expect(approvalDetail({ command: "ls" })).toEqual({ headline: "ls", rest: null });
  });
});
