/**
 * A Claude session run through the Agent SDK (ADR-0143), as its composer handles it: the runner
 * owns the band before anything else, Send and Stop and the mode chip go to the runner, and the
 * question and approvals waiting in the runner are what the band draws.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DISCONNECTED_CLAUDE_SDK_STATE, type ClaudeSdkSessionState } from "@agentdesk/agent-feed-wire";
import { compactControl, composerActions, submitComposer } from "@/features/session-view/composer/sessionComposerActions";
import { composerCaption, composerEditor } from "@/features/session-view/composer/sessionComposerEditor";
import { composerTransport, type ComposerModel } from "@/features/session-view/composer/sessionComposerModel";
import { nextPermissionMode, type SdkSessionHandle } from "@/features/cli-input/useSdkSession";
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
};

function handle(state: Partial<ClaudeSdkSessionState> = {}, overrides: Partial<SdkSessionHandle> = {}): SdkSessionHandle {
  return {
    state: { ...LIVE, ...state },
    pending: false,
    error: null,
    send: vi.fn(async () => true),
    interrupt: vi.fn(async () => true),
    decide: vi.fn(async () => true),
    cycleMode: vi.fn(async () => true),
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
    ...overrides,
  } as ComposerModel;
}

describe("which surface owns the composer", () => {
  const none = { mirrored: false, terminalCandidate: false, windowCandidate: false, windowRefused: false, agentTerminal: null };

  it("is the runner for an SDK session, ahead of a pane or a window", () => {
    expect(composerTransport({ ...none, sdkCandidate: true, mirrored: true, windowCandidate: true }).kind).toBe("sdk-session");
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
    expect(m.sdkSession.send).toHaveBeenCalledWith("hello");
    expect(m.setLocalDraft).toHaveBeenCalledWith("");
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
      stop.onClick();
      expect(m.sdkSession.interrupt).toHaveBeenCalled();
    }
  });

  it("shows the runner's mode and steps it, and cannot while no runner answers", () => {
    const m = sdkModel(handle({ permissionMode: "plan" }));
    const chip = composerActions(m).find((action) => action.key === "permission-mode")!;
    expect(chip.ariaLabel).toBe("Permission mode Plan, switch to the next");
    chip.onClick();
    expect(m.sdkSession.cycleMode).toHaveBeenCalled();
    const gone = sdkModel(handle({ ...DISCONNECTED_CLAUDE_SDK_STATE }));
    expect(composerActions(gone).find((action) => action.key === "permission-mode")?.disabled).toBe(true);
  });

  it("compacts by sending /compact as a turn, and not over a draft or without a runner", async () => {
    const m = sdkModel(handle(), { editorValue: "" });
    await compactControl(m)!.run();
    expect(m.sdkSession.send).toHaveBeenCalledWith("/compact");
    expect(compactControl(sdkModel())!.blocked).toBe("Send or clear the draft in the composer first.");
    expect(compactControl(sdkModel(handle({ connected: false }), { editorValue: "" }))!.blocked).toBe("This session is not running.");
  });

  it("says when there is no runner, and says the runner's refusal", () => {
    const gone = sdkModel(handle({ connected: false }));
    expect(composerEditor(gone).placeholder).toBe("This session is not running");
    expect(composerCaption(gone)).toEqual({ caption: "This session is not running.", captionIsError: false });
    expect(composerCaption(sdkModel(handle({}, { error: "That request is no longer waiting." }))))
      .toEqual({ caption: "That request is no longer waiting.", captionIsError: true });
  });
});

describe("the mode cycle", () => {
  it("follows the terminal's order, and skips bypass where the launch did not allow it", () => {
    expect(nextPermissionMode("auto", true)).toBe("acceptEdits");
    expect(nextPermissionMode("plan", true)).toBe("bypassPermissions");
    expect(nextPermissionMode("plan", false)).toBe("manual");
    expect(nextPermissionMode("manual", false)).toBe("auto");
    expect(nextPermissionMode(null, false)).toBe("auto");
  });
});

describe("the runner's question", () => {
  it("is drawn from the call the runner holds, by its tool-use id", () => {
    const shown = runnerQuestion({
      ...LIVE,
      pending: [{
        kind: "question",
        toolUseId: "toolu_1",
        openedAt: 1,
        questions: [{ question: "Which tree?", header: "Tree", multiSelect: false, options: [{ label: "Oak", description: "" }] }],
      }],
    });
    expect(shown).toEqual({
      callId: "toolu_1",
      questions: [{ question: "Which tree?", header: "Tree", multiSelect: false, options: [{ label: "Oak" }] }],
    });
    expect(runnerQuestion(LIVE)).toBeNull();
  });

  it("is refused in words that do not mention a terminal", () => {
    for (const reason of ["no-pane", "tmux-unavailable", "no-dialog", "wrong-dialog", "wrong-option", "pane-stalled", "still-open"] as const) {
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
    expect(approvalDetail({ todos: [1] })).toBe(JSON.stringify({ todos: [1] }, null, 2));
  });
});
