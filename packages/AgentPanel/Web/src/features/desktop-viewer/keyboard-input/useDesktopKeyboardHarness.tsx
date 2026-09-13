// One rendered hook, with the DOM events jsdom will not produce on its own.
//
// A module rather than a copy per test file: `setup` renders the same capture textarea
// and stand-in accessory the hook measures, and the paste and beforeinput helpers exist
// because jsdom has no clipboard and React's synthetic paste has to be driven directly.

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import type { DesktopControlInput, DesktopCursorKind } from "@agentdesk/agent-feed-wire";
import type { DesktopControlTransport } from "../tile-stream/TileStreamRtc";
import { useDesktopKeyboard, type DesktopKeyboardTelemetry } from "./useDesktopKeyboard";

export 
type Controller = ReturnType<typeof useDesktopKeyboard>;

function Harness({
  transport,
  cursorKind,
  report,
  expose,
}: {
  transport: DesktopControlTransport | null;
  cursorKind: () => DesktopCursorKind;
  report: (event: DesktopKeyboardTelemetry) => void;
  expose: (controller: Controller) => void;
}) {
  const controller = useDesktopKeyboard({ transport, cursorKind, report });
  expose(controller);
  return (
    <>
      <textarea
        ref={controller.captureRef}
        aria-label="capture"
        {...controller.captureProps}
      />
      {/* Stands in for the portaled accessory, which is what the hook measures. */}
      {controller.keyboardPresented
        ? <section ref={controller.accessoryRef} aria-label="accessory" />
        : null}
    </>
  );
}

/** Every test but the prime gate's own taps an I-beam, which is the case that opens a keyboard. */
export function setup(cursorKind: () => DesktopCursorKind = () => "ibeam") {
  const sent: DesktopControlInput[] = [];
  const transport: DesktopControlTransport = {
    send(input) {
      sent.push(input);
      return "sent";
    },
  };
  const report = vi.fn();
  let controller!: Controller;
  render(<Harness transport={transport} cursorKind={cursorKind} report={report}
    expose={(next) => { controller = next; }} />);
  return {
    sent, transport, report,
    get controller() { return controller; },
    capture: screen.getByLabelText("capture"),
  };
}

/** React's synthetic paste, driven directly: jsdom has no clipboard to put data on. */
export function paste(controller: Controller, text: string) {
  controller.captureProps.onPaste({
    preventDefault() {},
    clipboardData: { getData: () => text },
  } as never);
}

export function editableFocus(controller: Controller, focusRequestId: string, secure = false) {
  controller.handleControlEvent({
    type: "text-focus",
    focusRequestId,
    editability: "editable",
    secure,
    source: "accessibility",
    cursorKind: "ibeam",
  });
}

export function beforeInput(_controller: Controller, element: HTMLTextAreaElement, inputType: string, data: string | null) {
  const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data });
  act(() => element.dispatchEvent(event));
  return event;
}

/**
 * Stands a ResizeObserver up for the accessory the hook measures, and hands back the
 * observers so a test can fire one. jsdom has none.
 *
 * Registers its own `beforeEach`/`afterEach`, so call it once inside a `describe`.
 */
export function stubAccessoryObserver(): Map<Element, () => void> {
  const accessoryObservers = new Map<Element, () => void>();

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: () => void) {}
      observe(element: Element) { accessoryObservers.set(element, this.callback); }
      disconnect() {}
    });
  });

  afterEach(() => {
    accessoryObservers.clear();
    vi.unstubAllGlobals();
  });

  return accessoryObservers;
}
