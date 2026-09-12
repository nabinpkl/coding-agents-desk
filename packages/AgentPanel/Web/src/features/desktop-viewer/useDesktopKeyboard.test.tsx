// Arming the keyboard: what a tap does before the Mac has answered, what replaces a tap
// still waiting, and which cursor shapes open a keyboard at all.

import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_CONTROL_MAX_TEXT_UNITS } from "@agentdesk/agent-feed-wire";
import {
  beforeInput,
  editableFocus,
  paste,
  setup,
  stubAccessoryObserver,
} from "@/features/desktop-viewer/useDesktopKeyboardHarness";

describe("useDesktopKeyboard", () => {
  stubAccessoryObserver();

  it("pre-arms synchronously, buffers input, then flushes one ordered batch", () => {
    const harness = setup();
    let requestID: string | undefined;
    act(() => { requestID = harness.controller.beforeRemoteClick(); });
    expect(requestID).toBeTruthy();
    expect(document.activeElement).toBe(harness.capture);
    expect(harness.controller.presentation.presentation).toBe("pending");

    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertText", "Ab");
    expect(harness.sent).toEqual([]);
    act(() => editableFocus(harness.controller, requestID!));
    expect(harness.sent).toEqual([{
      type: "key-batch",
      sequence: 1,
      keys: [
        { code: "ansi-A", modifiers: ["shift"] },
        { code: "ansi-B", modifiers: [] },
      ],
    }]);
  });

  it("replaces a pending tap, discards its keys, and ignores its focus result", () => {
    const harness = setup();
    let first: string | undefined;
    let second: string | undefined;
    act(() => { first = harness.controller.beforeRemoteClick(); });
    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertText", "a");
    act(() => { second = harness.controller.beforeRemoteClick(); });
    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertText", "b");

    act(() => editableFocus(harness.controller, first!));
    expect(harness.sent).toEqual([]);
    act(() => editableFocus(harness.controller, second!));
    expect(harness.sent).toEqual([{
      type: "key-batch",
      sequence: 1,
      keys: [{ code: "ansi-B", modifiers: [] }],
    }]);
  });

  it("discards pending keys and blurs when focus times out", () => {
    vi.useFakeTimers();
    try {
      const harness = setup();
      act(() => harness.controller.beforeRemoteClick());
      beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertText", "a");
      act(() => vi.advanceTimersByTime(700));
      expect(harness.controller.presentation.presentation).toBe("hidden");
      expect(document.activeElement).not.toBe(harness.capture);
      expect(harness.sent).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the keyboard alone when the tap lands under a non-text cursor", () => {
    const harness = setup(() => "arrow");
    let requestID: string | undefined;
    act(() => { requestID = harness.controller.beforeRemoteClick(); });
    // No request id means the click still reaches the Mac but carries no focus correlation, so the
    // helper never probes and nothing here has to be undone a moment later.
    expect(requestID).toBeUndefined();
    expect(document.activeElement).not.toBe(harness.capture);
    expect(harness.controller.presentation.presentation).toBe("hidden");
    // The phase has to be one the sidecar's telemetry allowlist already accepts, or the record is
    // a 400 on every tap instead of a diagnostic.
    expect(harness.report).toHaveBeenCalledWith({
      phase: "keyboard-state",
      detail: { event: "prime-skipped", cursorKind: "arrow" },
    });
  });

  it("still primes before the cursor mirror has named a shape", () => {
    const harness = setup(() => "unknown");
    let requestID: string | undefined;
    act(() => { requestID = harness.controller.beforeRemoteClick(); });
    expect(requestID).toBeTruthy();
    expect(document.activeElement).toBe(harness.capture);
    expect(harness.controller.presentation.presentation).toBe("pending");
  });

  it("opens on request even under a non-text cursor", () => {
    const harness = setup(() => "arrow");
    act(() => harness.controller.showManually());
    // The gate is a guess about an unasked-for keyboard. The Keyboard button is the ask.
    expect(document.activeElement).toBe(harness.capture);
    expect(harness.controller.presentation.presentation).toBe("shown");
  });
});
