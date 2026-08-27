import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesktopControlInput } from "@agentdesk/agent-feed-wire";
import type { DesktopControlTransport } from "./TileStreamRtc";
import { useDesktopKeyboard } from "./useDesktopKeyboard";

type Controller = ReturnType<typeof useDesktopKeyboard>;

function Harness({
  transport,
  expose,
}: {
  transport: DesktopControlTransport | null;
  expose: (controller: Controller) => void;
}) {
  const controller = useDesktopKeyboard({ transport, report: vi.fn() });
  expose(controller);
  return (
    <textarea
      ref={controller.captureRef}
      aria-label="capture"
      {...controller.captureProps}
    />
  );
}

function setup() {
  const sent: DesktopControlInput[] = [];
  const transport: DesktopControlTransport = {
    send(input) {
      sent.push(input);
      return "sent";
    },
  };
  let controller!: Controller;
  render(<Harness transport={transport} expose={(next) => { controller = next; }} />);
  return { sent, transport, get controller() { return controller; }, capture: screen.getByLabelText("capture") };
}

function editableFocus(controller: Controller, focusRequestId: string, secure = false) {
  controller.handleControlEvent({
    type: "text-focus",
    focusRequestId,
    editability: "editable",
    secure,
    source: "accessibility",
    cursorKind: "ibeam",
  });
}

function beforeInput(_controller: Controller, element: HTMLTextAreaElement, inputType: string, data: string | null) {
  const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data });
  act(() => element.dispatchEvent(event));
  return event;
}

describe("useDesktopKeyboard", () => {
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

  it("does not mistake a resized WKWebView for a dismissed keyboard", () => {
    const previous = window.visualViewport;
    const originalHeight = window.innerHeight;
    const viewport = Object.assign(new EventTarget(), { height: originalHeight, offsetTop: 0 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      const harness = setup();
      act(() => harness.controller.showManually());
      viewport.height = originalHeight - 300;
      act(() => viewport.dispatchEvent(new Event("resize")));
      Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.height });
      act(() => viewport.dispatchEvent(new Event("resize")));
      beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "deleteContentBackward", null);
      expect(harness.controller.presentation.presentation).toBe("shown");
      expect(harness.controller.softwareKeyboardVisible).toBe(true);
      expect(harness.controller.accessoryBottom).toBe(0);
      expect(document.activeElement).toBe(harness.capture);
    } finally {
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
    }
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
    expect(harness.sent[0]).toMatchObject({ type: "key-batch", keys: expect.any(Array) });
    fireEvent.paste(harness.capture, { clipboardData: { getData: () => "ok😀bad" } });
    expect(harness.sent).toHaveLength(2);
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

  it("dismisses from visualViewport events without polling", () => {
    const previous = window.visualViewport;
    const viewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
    };
    viewport.height = window.innerHeight;
    viewport.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      const harness = setup();
      act(() => harness.controller.showManually());
      viewport.height = window.innerHeight - 200;
      act(() => viewport.dispatchEvent(new Event("resize")));
      viewport.height = window.innerHeight;
      act(() => viewport.dispatchEvent(new Event("resize")));
      expect(harness.controller.presentation.presentation).toBe("hidden");
      expect(harness.controller.softwareKeyboardVisible).toBe(false);
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
    }
  });
});
