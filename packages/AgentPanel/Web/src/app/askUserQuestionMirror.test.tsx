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
vi.mock("@/features/activity-feed/blocks/DiffBlock", async () => {
  const { diffBlockModule } = await import("@/app/agentPanelAppMocks");
  return diffBlockModule();
});

describe("AskUserQuestion mirror", () => {
  // The same panel the live probe saw in Claude Desktop: question, header,
  // single-select options, Other, Skip, Submit, and the header controls.
  const QUESTION = {
    callId: "toolu_01RiU9jjyzyX3HTCbLG1dGAh",
    questions: [{
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
    }],
  };

  const MULTI_QUESTION = {
    callId: "toolu_02",
    questions: [{
      question: "Which features do you want to enable?",
      multiSelect: true,
      options: [
        { label: "Dark mode", description: "Enable dark theme for the interface" },
        { label: "Notifications", description: "Receive real-time alerts and updates" },
        { label: "Analytics", description: "Track usage and performance metrics" },
      ],
    }],
  };

  /** A call carrying more than one question, which is what the Desktop panel cannot finish. */
  const TWO_QUESTIONS = {
    callId: "toolu_03",
    questions: [
      MULTI_QUESTION.questions[0]!,
      {
        question: "And which environment?",
        multiSelect: false,
        options: [{ label: "Staging" }, { label: "Production" }],
      },
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

  /** The free-text row's label, which names its question so several of them stay distinct. */
  const OTHER =
    "Your own answer to: Which release identity should the manual deploy of current main use?";

  function openQuestion(question: unknown) {
    act(() => feedMock.emitQuestion?.(question));
  }

  /**
   * Opens a question AND has the host affirm its panel, which is what hands it to this half.
   *
   * Affirmation is required now that there is another half. A question the host has said nothing
   * about yet belongs to the reader's own draft -- it is drawn from the tool call and needs no
   * window at all -- so a window test that only opened the question would be testing the draft.
   */
  function openWindowQuestion(transport: FakeHttpTransport, question: unknown) {
    openQuestion(question);
    deliverQuestionStatus(transport);
  }

  it("renders the panel from the feed JSON: question, options, Other, and every action", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openWindowQuestion(transport, QUESTION);

    expect(screen.getByLabelText("Claude question")).toHaveTextContent(
      "Which release identity should the manual deploy of current main use?",
    );
    // Single-select questions render radio rows, and the free-text row is one of them: on this
    // shape an option and your own words are alternatives, so they belong to one group.
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(
      screen.getByRole("radio", { name: "Mint 2026-08-08.1 (Recommended)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Don't deploy app code yet" }),
    ).toBeInTheDocument();
    // Descriptions are drawn with their options rather than behind an expand control: the panel
    // has the room the terminal dialog does not, and this is the surface with the whole JSON.
    expect(screen.getByText("Add a ledger entry for a new application release.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss question" })).toBeInTheDocument();
    expect(screen.getByLabelText(OTHER)).toHaveAttribute("placeholder", "Something else");
    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDisabled();

    // The mirror watches the live panel state while the question is open.
    expect(questionStreamOpen(transport)).toBe(true);
    unmount();
  });

  it("posts a select action on choice and adopts the post-action read-back", async () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openWindowQuestion(transport, QUESTION);

    answerQuestion(transport, { sel: [1], sb: true });
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
    openWindowQuestion(transport, MULTI_QUESTION);

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
    openWindowQuestion(transport, QUESTION);
    answerQuestion(transport, { ot: "Deploy a different release", sb: true });

    const other = screen.getByLabelText(OTHER);
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
    openWindowQuestion(transport, QUESTION);
    deliverQuestionStatus(transport, { sel: [0], sb: true });
    answerQuestion(transport, { sel: [0], sb: true });

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

  it("hands the question back to the reader's own draft when the panel is gone", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openWindowQuestion(transport, QUESTION);
    deliverQuestionStatus(transport, { pr: false });

    // The question does not go away with the window. Its content is the tool call in the
    // transcript, and the session is still waiting on an answer -- so what is left is the half
    // that needs no window: the reader's own draft, committed wherever the session is running.
    // Skip and Dismiss go, because they are things only the Desktop panel can be asked to do.
    expect(screen.getByLabelText("Claude question")).toHaveTextContent(
      "Which release identity should the manual deploy of current main use?",
    );
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss question" })).toBeNull();
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

  it("answers a terminal session itself rather than explaining that it is a terminal session", () => {
    const { transport, fake, unmount } = setup();
    openClaudeThread(transport);
    openWindowQuestion(transport, QUESTION);
    deliverQuestionStatus(transport, { en: false, r: "terminal-only", pr: null });

    // This used to draw a disabled mirror whose only content was the news that the session runs in
    // a terminal, which is the one case the other half is FOR. The reader gets a live surface: the
    // question from the tool call, answerable against the pane the session is actually in.
    expect(screen.getByRole("radio", { name: "Mint 2026-08-08.1 (Recommended)" })).toBeEnabled();
    expect(screen.getByLabelText("Claude question")).not.toHaveTextContent("running in a terminal");
    unmount();
  });

  it("draws a question with no window and no pane, because the tool call is all it needs", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    // No status from the host, and nothing asked of tmux. A question is content the transcript
    // already carries, so nothing has to be true about where the session is running for its
    // reader to see it and start answering.
    openQuestion(TWO_QUESTIONS);

    expect(screen.getByText("Which features do you want to enable?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next question" })).toBeInTheDocument();
    expect(screen.queryByText(/can only be answered in the app/)).toBeNull();
    unmount();
  });

  it("leaves the pane alone for a thread being read, and attaches for an open question", () => {
    const { transport, unmount } = setup();
    const paneStream = () =>
      transport.subscriptions.filter((open) => open.path.includes("/composer/stream"))
        .filter((open) => !open.path.includes("/window/"));

    // Opening the stream puts a `tmux pipe-pane` on the session's pane, so reading a thread must
    // not do it. That half is unchanged: everything on screen for a thread nobody is typing into
    // comes from files the sidecar already watches.
    openClaudeThread(transport);
    expect(paneStream()).toHaveLength(0);

    // An open question is different, and this is the rule that moved. While the dialog stands in
    // that pane it is a live surface somebody may be walking with the arrow keys, and where they
    // have got to is the one thing the panel cannot learn from a file. Waiting for a touch meant
    // a reader had to answer before they could see what was already answered -- so the mirror's
    // first act was to show them nothing.
    openQuestion(TWO_QUESTIONS);
    expect(paneStream().length).toBeGreaterThan(0);
    unmount();
  });

  it("folds the question down to one row and puts it back, keeping the draft", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(TWO_QUESTIONS);

    fireEvent.click(screen.getByRole("checkbox", { name: "Dark mode" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse question" }));

    // The panel is gone and the row that reopens it is not: the question's own words, so the
    // reader knows what they folded away, and no options to answer it in place.
    const reopen = screen.getByRole("button", {
      name: /Reopen Claude's question: Which features do you want to enable\?/,
    });
    expect(reopen).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("checkbox", { name: "Dark mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    // One of the two is answered already, which is the fact reopening would be for.
    expect(reopen).toHaveTextContent("1 of 2 left");

    fireEvent.click(reopen);
    // The draft is the caller's, not the panel's, so folding it away never touched it.
    expect(screen.getByRole("checkbox", { name: "Dark mode" })).toBeChecked();
    unmount();
  });

  it("opens a NEW call whole, however the last one was left", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    openQuestion(TWO_QUESTIONS);
    fireEvent.click(screen.getByRole("button", { name: "Collapse question" }));
    expect(screen.queryByRole("button", { name: "Collapse question" })).toBeNull();

    // A question nobody has seen yet is not one anybody asked to hide.
    openQuestion(QUESTION);
    expect(
      screen.getByRole("radio", { name: "Mint 2026-08-08.1 (Recommended)" }),
    ).toBeInTheDocument();
    unmount();
  });

  it("says how many questions of a call this half cannot reach", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    openWindowQuestion(transport, TWO_QUESTIONS);

    // The Desktop panel is single-pane and nothing has measured what it does with a call carrying
    // several, so this half answers the first and says so rather than pretending to finish.
    expect(screen.getByLabelText("Claude question")).toHaveTextContent(
      "1 more question in this call can only be answered in the app",
    );
    expect(screen.queryByText("And which environment?")).toBeNull();
    unmount();
  });
});
