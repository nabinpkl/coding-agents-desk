// Where the desktop viewer's key rail is drawn: on the keyboard bar while the phone's own keyboard
// is up, and in the accessory over the panel's deck. Through the real keyboard watcher and bar.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { installKeyboardInset } from "@/app/page/keyboardInset";
import { DesktopKeyboardChrome } from "@/features/desktop-viewer/keyboard-input/DesktopKeyboardChrome";
import { OFF_MODIFIERS } from "@/features/desktop-viewer/keyboard-input/desktopKeyboardPreferences";
import { KeyboardBar } from "@/features/keyboard/KeyboardBar";

let keyboard: { remove(): void } | null = null;

afterEach(() => {
  keyboard?.remove();
  keyboard = null;
  vi.unstubAllGlobals();
});

/** A phone, with its keyboard covering `covered` pixels of an 844px screen. */
function phone(covered: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal(
    "visualViewport",
    Object.assign(new EventTarget(), { height: 844 - covered, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 }),
  );
  keyboard = installKeyboardInset();
}

function renderChrome(overrides: Partial<ComponentProps<typeof DesktopKeyboardChrome>>) {
  const captureRef = createRef<HTMLTextAreaElement>();
  const onKey = vi.fn();
  const props: ComponentProps<typeof DesktopKeyboardChrome> = {
    captureRef,
    accessoryRef: createRef<HTMLElement>(),
    captureProps: {},
    shown: true,
    available: true,
    autoKeyboard: true,
    modifiers: OFF_MODIFIERS,
    receipt: [],
    localEcho: [],
    deliveryStatus: null,
    bottom: 336,
    softwareKeyboardVisible: true,
    onShow: vi.fn(),
    onHide: vi.fn(),
    onAutoChange: vi.fn(),
    onKey,
    onModifier: vi.fn(),
    onPasteToMac: vi.fn(),
    onDeckCharacter: vi.fn(),
    onDeckCursorDelta: vi.fn(),
    onDeckBackspace: vi.fn(),
    draft: null,
    onSendDraft: vi.fn(),
    onCancelDraft: vi.fn(),
    showsDeck: false,
    deckAvailable: true,
    onKeyboardMode: vi.fn(),
    ...overrides,
  };
  render(
    <>
      <KeyboardBar />
      <DesktopKeyboardChrome {...props} />
    </>,
  );
  act(() => captureRef.current!.focus());
  return { onKey };
}

it("puts the rail on the keyboard bar while the phone's keyboard is up, with the strip standing on the bar", () => {
  phone(336);
  const { onKey } = renderChrome({});

  const bar = screen.getByRole("toolbar", { name: "Keyboard keys" });
  const accessory = screen.getByRole("region", { name: "Remote keyboard controls" });
  expect(within(bar).getByLabelText("Remote key rail")).toBeInTheDocument();
  expect(within(accessory).queryByLabelText("Remote key rail")).toBeNull();
  // The bar's own Esc gives way to the Mac's.
  expect(screen.getAllByRole("button", { name: "Esc" })).toHaveLength(1);
  // The strip stands on the bar, which stands on the keyboard.
  expect(accessory.style.bottom).toBe(`${336 + 64}px`);

  fireEvent.click(within(bar).getByRole("button", { name: "Esc" }));
  expect(onKey).toHaveBeenCalledWith("escape");
});

it("keeps the rail in the accessory over the panel's own deck, where no bar stands", () => {
  phone(0);
  renderChrome({ showsDeck: true, softwareKeyboardVisible: false, bottom: 0 });

  expect(screen.queryByRole("toolbar", { name: "Keyboard keys" })).toBeNull();
  const accessory = screen.getByRole("region", { name: "Remote keyboard controls" });
  expect(within(accessory).getByLabelText("Remote key rail")).toBeInTheDocument();
  expect(accessory.style.bottom).toBe("0px");
});
