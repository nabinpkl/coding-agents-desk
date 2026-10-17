/**
 * Typing into a Claude Desktop window's own composer through the panel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor } from "@testing-library/react";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import {
  COMPOSER_STREAM,
  openClaudeThread,
  restoreViewport,
  setup,
} from "@/app/agentPanelAppHarness";

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
vi.mock("@/features/activity-feed/blocks/diff/DiffBlock", async () => {
  const { diffBlockModule } = await import("@/app/agentPanelAppMocks");
  return diffBlockModule();
});

describe("Claude window composer field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    restoreViewport();
  });

  /**
   * Focuses the Claude field, which is what opens the composer stream: the watch is focus-gated.
   *
   * Claude's composer is served by the sidecar now (ADR-0110), so the seam these tests drive is the
   * HTTP transport rather than the host bridge. Codex still uses the lane, which is why the Codex
   * test below still asserts on `fake.posted`.
   */
  function focusComposer(_transport: FakeHttpTransport) {
    const field = screen.getByLabelText("Claude composer text");
    fireEvent.focus(field);
    return { field };
  }

  /** One status frame on the composer stream. The short keys are the test's, not the wire's. */
  function deliverStatus(transport: FakeHttpTransport, overrides: Record<string, unknown> = {}) {
    const { en = true, cur = true, tx = "", r = null, sid = "sid-claude-01" } = overrides;
    act(() => {
      transport.deliver(COMPOSER_STREAM, {
        composer: {
          sessionId: sid,
          enabled: en,
          reason: r,
          onActiveDesktop: cur,
          composerText: tx,
        },
      });
    });
  }

  /** Every composer command of one kind the panel issued, in order. */
  function composerCalls(transport: FakeHttpTransport, kind: "sync" | "submit" | "read") {
    return transport.requests.filter((request) => request.path === `/api/window/composer/${kind}`);
  }

  /** The body of the last composer command of one kind, for a `toMatchObject` on what was sent. */
  function lastComposerCall(transport: FakeHttpTransport, kind: "sync" | "submit" | "read") {
    return composerCalls(transport, kind).at(-1)?.body;
  }

  /**
   * Pre-seeds what a composer command answers.
   *
   * Seeded BEFORE the action rather than delivered after it, because a POST resolves its own
   * promise: there is no correlation id to answer late against, which is most of why this path is
   * simpler than the lane it replaced.
   */
  function answerComposer(
    transport: FakeHttpTransport,
    kind: "sync" | "submit" | "read",
    body: unknown,
    status = 200,
  ) {
    transport.responses.set(`POST /api/window/composer/${kind}`, {
      status,
      body: JSON.stringify(body),
    });
  }
  it("is focusable before the first status, then disabled with the host's reason", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);

    // Focusable before any status: the watch is focus-gated, so a field disabled "until a status
    // arrives" could never be focused and the status would never arrive.
    expect(screen.getByLabelText("Claude composer text")).toBeEnabled();

    focusComposer(transport);
    deliverStatus(transport, { en: false, r: "terminal-only" });

    expect(screen.getByLabelText("Claude composer text")).toBeDisabled();
    expect(screen.getByLabelText("Claude window composer")).toHaveTextContent(
      "running in a terminal",
    );
    // The only explicit action left is Enter, and it cannot fire without a window.
    expect(screen.getByRole("button", { name: "Send to Claude's composer" })).toBeDisabled();
    unmount();
  });

  it("does not read as unavailable before the watch has said anything", () => {
    // The watch is focus-gated, so an unfocused session has no status, and keying the placeholder
    // on `enabled` alone made every one of them announce "Composer unavailable" -- most visibly on
    // a passively-watched thread, where nothing ever focuses the field. The field is usable here,
    // and the placeholder has to say so.
    const { transport, unmount } = setup();
    openClaudeThread(transport);

    const field = screen.getByLabelText("Claude composer text");
    expect(field).toBeEnabled();
    expect(field).toHaveAttribute("placeholder", expect.stringContaining("Type into Claude"));

    focusComposer(transport);
    deliverStatus(transport, { en: false, r: "no-window" });

    expect(screen.getByLabelText("Claude composer text"))
      .toHaveAttribute("placeholder", "Composer unavailable");
    unmount();
  });

  it("names the two-instance case instead of leaving it as a bare unavailable", () => {
    // The host used to resolve this by picking the lowest-pid instance, which wrote into whichever
    // Claude launched first. Now it refuses and says so, and the viewer's fix -- close the session in
    // one of them -- has to be readable from the notice alone.
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    focusComposer(transport);

    deliverStatus(transport, { en: false, r: "multiple-instances" });

    expect(screen.getByLabelText("Claude composer text")).toBeDisabled();
    expect(screen.getByLabelText("Claude window composer")).toHaveTextContent(
      "more than one Claude instance",
    );
    unmount();
  });

  it("prefills from the window on focus and auto-syncs every edit after a debounce", async () => {
    vi.useFakeTimers();
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);

    deliverStatus(transport, { tx: "half-written prompt" });

    expect(field).toBeEnabled();
    expect(field).toHaveValue("half-written prompt");

    fireEvent.change(field, { target: { value: "review the diff" } });
    // No fill button anymore, and Return still never sends: the sync is automatic.
    expect(screen.queryByRole("button", { name: "Fill Claude's composer" })).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(
      composerCalls(transport, "sync"),
    ).toHaveLength(0);

    // One burst of typing lands as one sync, 500ms after the last keystroke.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(lastComposerCall(transport, "sync")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "review the diff",
    });
    unmount();
  });

  it("clearing the field is an edit, so deletions sync as the empty value", async () => {
    vi.useFakeTimers();
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "text to delete" });

    fireEvent.change(field, { target: { value: "" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(lastComposerCall(transport, "sync")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "",
    });
    unmount();
  });

  it("retries a draft when the leased Claude window becomes active", async () => {
    vi.useFakeTimers();
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);

    // The lease is still being acquired. Typing is allowed, but the first debounce cannot send to
    // an off-Desktop window yet.
    deliverStatus(transport, { cur: false, tx: null });
    fireEvent.change(field, { target: { value: "sync after lease" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(
      composerCalls(transport, "sync"),
    ).toHaveLength(0);

    // The host's lease status flips active. The debounce effect must wake up and retry the existing
    // unsynced draft without requiring another keystroke.
    deliverStatus(transport, { cur: true, tx: "" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(lastComposerCall(transport, "sync")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "sync after lease",
    });
    unmount();
  });

  it("blur flushes an unsynced edit and unwatches, stopping the host's poll", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "" });

    fireEvent.change(field, { target: { value: "about to leave" } });
    fireEvent.blur(field);

    // The flush lands before the stream closes, so nothing typed is lost. Closing the stream is
    // what releases the window's editing lease and stops the sidecar's poll.
    expect(lastComposerCall(transport, "sync")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "about to leave",
    });
    expect(transport.subscriptions.some((open) => open.path.includes(COMPOSER_STREAM))).toBe(false);
    unmount();
  });

  it("an echo of our own write marks the field in sync; an independent edit then lands", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "" });

    fireEvent.change(field, { target: { value: "mid" } });
    // The host's write echo arrives while the draft is still "unsent": matching text means field and
    // window agree again, so a LATER independent edit must be adopted rather than guarded forever.
    deliverStatus(transport, { tx: "mid" });
    deliverStatus(transport, { tx: "edited directly in Claude" });

    expect(field).toHaveValue("edited directly in Claude");
    unmount();
  });

  it("does not overwrite an in-flight edit with a status that arrives while typing", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "" });

    fireEvent.change(field, { target: { value: "mid-sentence" } });

    // The host re-resolves on a timer, so a status carrying the window's own text can land at any
    // moment. Adopting it here would delete what the viewer just typed.
    deliverStatus(transport, { tx: "whatever the window holds" });

    expect(field).toHaveValue("mid-sentence");
    unmount();
  });

  it("does not overwrite newer typing with a stale sync result that resolves late", async () => {
    vi.useFakeTimers();
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "" });

    // The sidecar answers the write with what the field read back, which is already stale by the
    // time it resolves: the user kept typing while Chromium settled the value.
    answerComposer(transport, "sync", { text: "first burst" });
    fireEvent.change(field, { target: { value: "first burst" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // Adopting the read-back here would truncate the field back to "first burst" mid-keystroke.
    fireEvent.change(field, { target: { value: "first burst, then more" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(field).toHaveValue("first burst, then more");
    unmount();
  });

  it("the Enter button actually sends by filling and pressing Return", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);
    deliverStatus(transport, { tx: "" });

    const sendButton = screen.getByRole("button", { name: "Send to Claude's composer" });
    expect(sendButton).toBeDisabled();

    fireEvent.change(field, { target: { value: "run the tests" } });
    expect(sendButton).toBeEnabled();

    fireEvent.click(sendButton);
    expect(lastComposerCall(transport, "submit")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "run the tests",
    });
    unmount();
  });

  it("an off-Desktop window is prefilled by one automatic round trip", async () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);

    answerComposer(transport, "read", { text: "found on the other Desktop" });
    deliverStatus(transport, { cur: false, tx: null });

    // No bring-window button: the round trip is the flow now, fired once on focus.
    expect(screen.queryByRole("button", { name: "Load from Claude window" })).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(composerCalls(transport, "read")).toHaveLength(1);
    await waitFor(() => expect(field).toHaveValue("found on the other Desktop"));
    unmount();
  });

  it("keeps the field editable while an off-Desktop prefill is in flight", () => {
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);

    deliverStatus(transport, { cur: false, tx: null });

    expect(lastComposerCall(transport, "read")).toMatchObject({ sessionId: "sid-claude-01" });
    expect(field).toBeEnabled();
    fireEvent.change(field, { target: { value: "typing while Claude is being read" } });
    expect(field).toHaveValue("typing while Claude is being read");
    unmount();
  });

  it("keeps off-Desktop typing local until Send performs one submit", async () => {
    vi.useFakeTimers();
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    const { field } = focusComposer(transport);

    answerComposer(transport, "read", { text: "draft from Claude" });
    deliverStatus(transport, { cur: false, tx: null });
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.change(field, { target: { value: "finish without moving the window" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(
      composerCalls(transport, "sync"),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Send to Claude's composer" }));
    expect(lastComposerCall(transport, "submit")).toMatchObject({
      sessionId: "sid-claude-01",
      text: "finish without moving the window",
    });
    unmount();
  });

  it("a failed round trip says a missing window mover is not something to retry", async () => {
    // Moving another application's window between Desktops uses a private native operation. If the
    // current macOS no longer exposes it, the automatic round trip fails once and the caption reports
    // an unavailable capability rather than inviting an endless retry.
    const { transport, unmount } = setup();
    openClaudeThread(transport);
    focusComposer(transport);

    answerComposer(
      transport,
      "read",
      { error: { code: "window-composer-failed", message: "window-mover-unavailable" } },
      503,
    );
    deliverStatus(transport, { cur: false, tx: null });

    await waitFor(() =>
      expect(screen.getByLabelText("Claude window composer")).toHaveTextContent(
        "does not expose the window mover",
      ));
    unmount();
  });
});
