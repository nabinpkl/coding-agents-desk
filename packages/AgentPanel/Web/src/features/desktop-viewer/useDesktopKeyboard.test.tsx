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
  return { sent, get controller() { return controller; }, capture: screen.getByLabelText("capture") };
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

function beforeInput(controller: Controller, element: HTMLTextAreaElement, inputType: string, data: string | null) {
  act(() => controller.captureProps.onBeforeInput?.({
    nativeEvent: { inputType, data, isComposing: false },
    currentTarget: element,
    preventDefault: vi.fn(),
  } as never));
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
  });

  it("rejects paste atomically and commits composition once", () => {
    const harness = setup();
    act(() => harness.controller.showManually());
    harness.sent.length = 0;

    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertFromPaste", "ok😀no");
    expect(harness.sent).toEqual([]);

    act(() => harness.controller.captureProps.onCompositionStart?.());
    beforeInput(harness.controller, harness.capture as HTMLTextAreaElement, "insertCompositionText", "a");
    act(() => harness.controller.captureProps.onCompositionEnd?.({
      data: "A", currentTarget: harness.capture,
    } as never));
    (harness.capture as HTMLTextAreaElement).value = "A";
    act(() => harness.controller.captureProps.onInput?.({
      currentTarget: harness.capture,
    } as never));
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
    act(() => harness.controller.handleControlEvent({ type: "input-applied", sequence: 1 }));
    expect(harness.controller.receipt).toEqual(["•"]);

    act(() => harness.controller.handleControlEvent({ type: "control-revoked", epoch: 2 }));
    expect(harness.controller.presentation.presentation).toBe("hidden");
    expect(harness.controller.receipt).toEqual([]);
    expect(harness.controller.modifiers).toEqual({
      cmd: "off", ctrl: "off", option: "off", shift: "off",
    });
  });

  it("dismisses from visualViewport events without polling", () => {
    const previous = window.visualViewport;
    const viewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
    };
    viewport.height = window.innerHeight - 200;
    viewport.offsetTop = 0;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    try {
      const harness = setup();
      act(() => harness.controller.showManually());
      act(() => viewport.dispatchEvent(new Event("resize")));
      viewport.height = window.innerHeight;
      act(() => viewport.dispatchEvent(new Event("resize")));
      expect(harness.controller.presentation.presentation).toBe("hidden");
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: previous });
    }
  });
});
