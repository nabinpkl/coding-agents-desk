// Getting text in: the clipboard button, pastes and dictation, composition, local echo,
// and the control keys that must not arrive twice.

import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_CONTROL_MAX_TEXT_UNITS } from "@agentdesk/agent-feed-wire";
import {
  beforeInput,
  editableFocus,
  paste,
  setup,
  stubAccessoryObserver,
} from "@/features/desktop-viewer/keyboard-input/useDesktopKeyboardHarness";

describe("useDesktopKeyboard", () => {
  stubAccessoryObserver();

  it("puts the clipboard on the Mac from a button, with no field taking focus", async () => {
    const harness = setup();
    act(() => harness.controller.showManually());
    harness.sent.length = 0;
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "caf\u00e9 \u2014 \ud83d\udc4b" } });

    await act(async () => { await harness.controller.pasteFromClipboard(); });

    expect(harness.sent).toEqual([
      { type: "text", sequence: 1, text: "caf\u00e9 \u2014 \ud83d\udc4b" },
    ]);
    expect(document.activeElement).not.toBe(null);
  });

  it("says so when the clipboard read is refused or unavailable", async () => {
    const harness = setup();
    act(() => harness.controller.showManually());
    harness.sent.length = 0;

    vi.stubGlobal("navigator", { clipboard: { readText: async () => { throw new Error("denied"); } } });
    await act(async () => { await harness.controller.pasteFromClipboard(); });
    expect(harness.controller.deliveryStatus).toBe("Paste not allowed: nothing was read");

    vi.stubGlobal("navigator", {});
    await act(async () => { await harness.controller.pasteFromClipboard(); });
    expect(harness.controller.deliveryStatus)
      .toBe("Paste unavailable: this browser will not read the clipboard");

    expect(harness.sent).toEqual([]);
  });

  it("pastes as characters, including ones no key code can express", () => {
    const harness = setup();
    let requestID: string | undefined;
    act(() => { requestID = harness.controller.beforeRemoteClick(); });
    act(() => editableFocus(harness.controller, requestID!));

    act(() => paste(harness.controller, "caf\u00e9 \u2014 \ud83d\udc4b"));

    // The key-position encoder would have refused this whole insertion at the em dash.
    expect(harness.sent).toEqual([
      { type: "text", sequence: 1, text: "caf\u00e9 \u2014 \ud83d\udc4b" },
    ]);
  });

  it("refuses a paste too long for one send rather than truncating it", () => {
    const harness = setup();
    let requestID: string | undefined;
    act(() => { requestID = harness.controller.beforeRemoteClick(); });
    act(() => editableFocus(harness.controller, requestID!));

    act(() => paste(harness.controller, "a".repeat(DESKTOP_CONTROL_MAX_TEXT_UNITS + 1)));

    expect(harness.sent).toEqual([]);
    expect(harness.controller.deliveryStatus).toBe("Text not sent: too long for one send");
  });

  it("handles empty backspace and hardware controls without duplicating text keydown", () => {
    const harness = setup();
    act(() => harness.controller.showManually());
    harness.sent.length = 0;

    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "deleteContentBackward", null);
    fireEvent.keyDown(harness.capture, { key: "a" });
    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertText", "a");
    fireEvent.keyDown(harness.capture, { key: "ArrowLeft" });

    expect(harness.sent.filter((input) => input.type === "key-batch")).toEqual([
      { type: "key-batch", sequence: 1, keys: [{ code: "delete", modifiers: [] }] },
      { type: "key-batch", sequence: 2, keys: [{ code: "ansi-A", modifiers: [] }] },
      { type: "key-batch", sequence: 3, keys: [{ code: "left", modifiers: [] }] },
    ]);
    expect(harness.controller.presentation.presentation).toBe("shown");
    expect(document.activeElement).toBe(harness.capture);
  });

  it("consumes native backspace without blurring or letting it navigate the page", () => {
    const harness = setup();
    act(() => harness.controller.showManually());
    const input = beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "deleteContentBackward", null);
    expect(input.defaultPrevented).toBe(true);
    expect(harness.controller.presentation.presentation).toBe("shown");
    expect(document.activeElement).toBe(harness.capture);
  });

  it("shows local echo immediately, deletes locally, and keeps receipts acknowledgement-only", () => {
    const harness = setup();
    let requestID: string | undefined;
    act(() => { requestID = harness.controller.beforeRemoteClick(); });
    act(() => editableFocus(harness.controller, requestID!));
    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertText", "Ab");
    expect(harness.controller.localEcho).toEqual(["A", "b"]);
    expect(harness.controller.receipt).toEqual([]);
    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "deleteContentBackward", null);
    expect(harness.controller.localEcho).toEqual(["A"]);
    act(() => harness.controller.handleControlEvent({ type: "input-applied", sequence: 1 }));
    expect(harness.controller.receipt).toEqual(["A", "b"]);
    expect(harness.controller.deliveryStatus).toBe("Delivering…");
    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertLineBreak", null);
    expect(harness.controller.localEcho).toEqual([]);
  });

  it("rejects paste atomically and commits composition once", () => {
    const harness = setup();
    act(() => harness.controller.showManually());
    harness.sent.length = 0;

    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertFromPaste", "ok😀no");
    expect(harness.sent).toEqual([]);

    fireEvent.compositionStart(harness.capture);
    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertCompositionText", "a");
    fireEvent.compositionEnd(harness.capture, { data: "A" });
    (harness.capture as HTMLTextAreaElement).value = "A";
    fireEvent.input(harness.capture, { inputType: "insertText", data: "A" });
    expect(harness.sent).toEqual([{
      type: "key-batch",
      sequence: 1,
      keys: [{ code: "ansi-A", modifiers: ["shift"] }],
    }]);
  });

  it("rejects pending overflow and oversized insertions before sending any prefix", () => {
    const harness = setup();
    act(() => harness.controller.beforeRemoteClick());
    beforeInput(
      harness.controller,
      harness.capture as HTMLTextAreaElement,
      "insertFromPaste",
      "a".repeat(33),
    );
    expect(harness.sent).toEqual([]);

    act(() => harness.controller.showManually());
    harness.sent.length = 0;
    beforeInput(
      harness.controller,
      harness.capture as HTMLTextAreaElement,
      "insertFromPaste",
      "a".repeat(257),
    );
    expect(harness.sent).toEqual([]);
  });

  it("adds only acknowledged secure bullets and clears on ownership loss", () => {
    const harness = setup();
    let requestID: string | undefined;
    act(() => { requestID = harness.controller.beforeRemoteClick(); });
    act(() => editableFocus(harness.controller, requestID!, true));
    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertText", "A");
    expect(harness.controller.localEcho).toEqual(["•"]);
    act(() => harness.controller.handleControlEvent({ type: "input-applied", sequence: 1 }));
    expect(harness.controller.receipt).toEqual(["•"]);

    act(() => harness.controller.handleControlEvent({ type: "control-revoked", epoch: 2 }));
    expect(harness.controller.presentation.presentation).toBe("hidden");
    expect(harness.controller.receipt).toEqual([]);
    expect(harness.controller.localEcho).toEqual([]);
    expect(harness.controller.modifiers).toEqual({
      cmd: "off", ctrl: "off", option: "off", shift: "off",
    });
  });

  it("preserves armed modifiers and echo when a backpressured channel refuses input", () => {
    const harness = setup();
    act(() => harness.controller.showManually());
    act(() => harness.controller.tapModifier("shift"));
    harness.transport.send = () => "backpressured";
    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertText", "a");
    expect(harness.controller.modifiers.shift).toBe("armed");
    expect(harness.controller.localEcho).toEqual([]);
    expect(harness.controller.receipt).toEqual([]);
    expect(harness.controller.presentation.presentation).toBe("shown");
  });

  it("handles non-cancelable beforeinput followed by input exactly once", () => {
    const harness = setup();
    act(() => harness.controller.showManually());
    harness.sent.length = 0;
    fireEvent(harness.capture, new InputEvent("beforeinput", {
      bubbles: true, cancelable: false, inputType: "insertText", data: "a",
    }));
    fireEvent.input(harness.capture, { target: { value: "a" }, inputType: "insertText", data: "a" });
    expect(harness.sent).toHaveLength(1);
  });

  it("captures paste and dictation atomically using actual DOM events", () => {
    const harness = setup();
    act(() => harness.controller.showManually());
    harness.sent.length = 0;
    fireEvent.paste(harness.capture, { clipboardData: { getData: () => "abc" } });
    fireEvent.input(harness.capture, { target: { value: "dictated words" }, inputType: "insertText", data: null });
    expect(harness.sent).toHaveLength(2);
    // A paste is one text message; dictation arrives as an insertion and is still keyed.
    expect(harness.sent[0]).toMatchObject({ type: "text", text: "abc" });
    expect(harness.sent[1]).toMatchObject({ type: "key-batch", keys: expect.any(Array) });
    // An emoji used to sink the entire paste, because no US key position can express it.
    fireEvent.paste(harness.capture, { clipboardData: { getData: () => "ok😀bad" } });
    expect(harness.sent).toHaveLength(3);
    expect(harness.sent[2]).toMatchObject({ type: "text", text: "ok😀bad" });
  });

  it("handles hardware backspace and return as single control keys while retaining focus", () => {
    const harness = setup();
    act(() => harness.controller.showManually());
    harness.sent.length = 0;
    expect(fireEvent.keyDown(harness.capture, { key: "Backspace" })).toBe(false);
    expect(fireEvent.keyDown(harness.capture, { key: "Enter" })).toBe(false);
    expect(harness.sent).toEqual([
      { type: "key-batch", sequence: 1, keys: [{ code: "delete", modifiers: [] }] },
      { type: "key-batch", sequence: 2, keys: [{ code: "return", modifiers: [] }] },
    ]);
    expect(document.activeElement).toBe(harness.capture);
    expect(harness.controller.presentation.presentation).toBe("shown");
  });
});
