/**
 * The AskUserQuestion panel, mirrored out of a Claude Desktop window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import {
  COMPOSER_STREAM,
  openClaudeThread,
  restoreViewport,
  setup,
} from "@/app/agentPanelAppHarness";
import {
  feedMock,
} from "@/app/agentPanelAppMocks";

vi.mock("@/features/activity-feed/ActivityFeed", async () => {
  const { activityFeedModule } = await import("@/app/agentPanelAppMocks");
  return activityFeedModule();
});
vi.mock("@/features/terminal/AgentTerminalPane", async () => {
  const { terminalPaneModule } = await import("@/app/agentPanelAppMocks");
  return terminalPaneModule();
});
vi.mock("@/features/activity-feed/markdown/Markdown", async () => {
  const { markdownModule } = await import("@/app/agentPanelAppMocks");
  return markdownModule();
});
vi.mock("@/features/activity-feed/DiffBlock", async () => {
  const { diffBlockModule } = await import("@/app/agentPanelAppMocks");
  return diffBlockModule();
});

describe("AskUserQuestion mirror", () => {
  // The same panel the live probe saw in Claude Desktop: question, header,
  // single-select options, Other, Skip, Submit, and the header controls.
  const QUESTION = {
    callId: "toolu_01RiU9jjyzyX3HTCbLG1dGAh",
    question: "Which release identity should the manual deploy of current main use?",
    header: "Release id",
    multiSelect: false,
    options: [
      {
        label: "Mint 2026-08-08.1 (Recommended)",
        description: "Add a ledger entry for a new application release.",
      },
      {
        label: "Reuse 2026-08-03.1",
        description: "Deploy immediately, no code change.",
      },
      {
        label: "Don't deploy app code yet",
        description: "Leave the running release alone.",
      },
    ],
  };

  const MULTI_QUESTION = {
    callId: "toolu_02",
    question: "Which features do you want to enable?",
    multiSelect: true,
    options: [
      { label: "Dark mode", description: "Enable dark theme for the interface" },
      { label: "Notifications", description: "Receive real-time alerts and updates" },
      { label: "Analytics", description: "Track usage and performance metrics" },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    feedMock.emitQuestion = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreViewport();
  });

  /**
   * Whether the composer stream is open. The question mirror shares it with the composer field,
   * because the sidecar reads both halves in one pass and sends them down one stream.
   */
  function questionStreamOpen(transport: FakeHttpTransport): boolean {
    return transport.subscriptions.some((open) => open.path.includes(COMPOSER_STREAM));
  }

  function deliverQuestionStatus(
    transport: FakeHttpTransport,
    overrides: Record<string, unknown> = {},
  ) {
    const { en = true, pr = true, sel = [], ot = null, sb = null, r = null } = overrides;
    act(() => {
      transport.deliver(COMPOSER_STREAM, {
        question: {
          sessionId: "sid-claude-01",
          enabled: en,
          reason: r,
          present: pr,
          selectedIndices: sel,
          otherText: ot,
          submitEnabled: sb,
        },
      });
    });
  }

  /** Every question action the panel posted, in order. */
  function questionCalls(transport: FakeHttpTransport) {
    return transport.requests.filter((request) => request.path === "/api/window/question/action");
  }

  function lastQuestionCall(transport: FakeHttpTransport) {
    return questionCalls(transport).at(-1)?.body;
  }

  /** Pre-seeds the post-action state a question action answers with. */
  function answerQuestion(transport: FakeHttpTransport, overrides: Record<string, unknown> = {}) {
    const { en = true, pr = true, sel = [], ot = null, sb = null, r = null } = overrides;
    transport.responses.set("POST /api/window/question/action", {
      status: 200,
      body: JSON.stringify({
        sessionId: "sid-claude-01",
        enabled: en,
        reason: r,
        present: pr,
        selectedIndices: sel,
        otherText: ot,
        submitEnabled: sb,
      }),
    });
  }

  function openQuestion(question: unknown) {
    act(() => feedMock.emitQuestion?.(question));
  }

  it("renders the panel from the feed JSON: question, options, Other, and every action", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);

    expect(screen.getByLabelText("Claude question")).toHaveTextContent(
      "Which release identity should the manual deploy of current main use?",
    );
    // Single-select questions render radio rows.
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(
      screen.getByRole("radio", { name: "Mint 2026-08-08.1 (Recommended)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Don't deploy app code yet" }),
    ).toBeInTheDocument();
    // The header controls and the action row mirror Claude's panel exactly.
    expect(screen.getByRole("button", { name: "View question options" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss question" })).toBeInTheDocument();
    expect(screen.getByLabelText("Other")).toBeInTheDocument();
    expect(screen.getByLabelText("Other answer")).toHaveAttribute(
      "placeholder",
      "Type your own answer here",
    );
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();

    // The mirror watches the live panel state while the question is open.
    expect(questionStreamOpen(transport)).toBe(true);
    unmount();
  });

  it("posts a select action on choice and adopts the post-action read-back", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);

    fireEvent.click(screen.getByRole("radio", { name: "Reuse 2026-08-03.1" }));
    const action = lastQuestionCall(transport) as Record<string, unknown>;
    expect(action).toMatchObject({ sessionId: "sid-claude-01", kind: "select", option: 1, desired: true });

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("radio", { name: "Reuse 2026-08-03.1" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeEnabled();
    unmount();
  });

  it("renders multi-select as checkboxes and un-checks by pressing with the desired state", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(MULTI_QUESTION);

    expect(screen.getAllByRole("checkbox").length).toBeGreaterThanOrEqual(3);
    const dark = screen.getByRole("checkbox", { name: "Dark mode" });
    // The panel answers the press with the post-action state: our option, checked, alongside a
    // selection made in the window itself.
    answerQuestion(transport, { sel: [0, 1], sb: true });
    fireEvent.click(dark);
    let action = lastQuestionCall(transport) as Record<string, unknown>;
    expect(action).toMatchObject({ kind: "select", option: 0, desired: true });

    // The host reports it landed, pre-checked alongside a host-side selection.
    await act(async () => {
      await Promise.resolve();
    });
    expect(dark).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Notifications" })).toBeChecked();

    // Un-checking a box asks the host to press it toward unchecked.
    fireEvent.click(dark);
    action = lastQuestionCall(transport) as Record<string, unknown>;
    expect(action).toMatchObject({ kind: "select", option: 0, desired: false });
    unmount();
  });

  it("debounces Other typing into an other action, and other-empty is a real intent", async () => {
    vi.useFakeTimers();
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);

    const other = screen.getByLabelText("Other answer");
    fireEvent.change(other, { target: { value: "Deploy a different release" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(lastQuestionCall(transport)).toMatchObject({
      sessionId: "sid-claude-01",
      kind: "other",
      text: "Deploy a different release",
    });

    // Clearing the input pushes the empty value, matching the composer's deletion rule.
    fireEvent.change(other, { target: { value: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(lastQuestionCall(transport)).toMatchObject({ kind: "other", text: "" });
    unmount();
  });

  it("posts submit, skip, and dismiss with no payload", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);
    deliverQuestionStatus(transport, { sel: [0], sb: true });

    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(
      lastQuestionCall(transport),
    ).toMatchObject({ kind: "submit" });
    // Each explicit action holds the controls until its result lands; resolve
    // between clicks so the next control is enabled again.
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(
      lastQuestionCall(transport),
    ).toMatchObject({ kind: "skip" });
    // Skip keeps the panel up in the window until Claude records it; only Dismiss
    // ends the test, so the mirror stays mounted.
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss question" }));
    expect(
      lastQuestionCall(transport),
    ).toMatchObject({ kind: "dismiss" });
    unmount();
  });

  it("adopts pre-checked selection from the window's live state", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(MULTI_QUESTION);
    deliverQuestionStatus(transport, { sel: [0, 2], sb: true });

    expect(screen.getByRole("checkbox", { name: "Dark mode" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Notifications" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Analytics" })).toBeChecked();
    unmount();
  });

  it("hides the mirror when the host reports the panel is gone, and closes the watch", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);
    deliverQuestionStatus(transport, { pr: false });

    expect(screen.queryByLabelText("Claude question")).toBeNull();
    unmount();
  });

  it("unwatches when the question closes in the feed", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);
    expect(questionStreamOpen(transport)).toBe(true);

    openQuestion(null);
    expect(questionStreamOpen(transport)).toBe(false);
    unmount();
  });

  it("surfaces the host's reason when the window is unreachable", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);
    deliverQuestionStatus(transport, { en: false, r: "terminal-only", pr: null });

    expect(screen.getByLabelText("Claude question")).toHaveTextContent(
      "running in a terminal",
    );
    expect(screen.getByRole("radio", { name: "Mint 2026-08-08.1 (Recommended)" })).toBeDisabled();
    unmount();
  });

  it("shows the option description when View options is toggled", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(QUESTION);

    expect(screen.queryByText("Add a ledger entry for a new application release.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View question options" }));
    expect(
      lastQuestionCall(transport),
    ).toMatchObject({ kind: "view-options" });
    expect(screen.getByText("Add a ledger entry for a new application release.")).toBeInTheDocument();
    unmount();
  });
});
