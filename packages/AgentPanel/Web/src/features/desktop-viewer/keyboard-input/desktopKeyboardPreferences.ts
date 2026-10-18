// What this reader chose about the keyboard, and the two constants that outlive one
// mounted surface.
//
// Read once at mount and written from the setter that changes it, per the panel's rule:
// which keyboard types is a fact about how this reader arranged the panel, and a reload
// that forgot it would put the browser's keyboard back over the deck they picked.

import type { RemoteModifier } from "@agentdesk/agent-feed-wire";
import type { ModifierState } from "@/features/desktop-viewer/keyboard-input/desktopKeyboardModel";
import type { KeyboardMode } from "@/features/desktop-viewer/keyboard-input/desktopKeyboardContext";

export const AUTO_KEYBOARD_STORAGE_KEY = "agentdesk.desktop-keyboard-auto.v2";
export const KEYBOARD_MODE_STORAGE_KEY = "agentdesk.desktop-keyboard-mode.v1";
// Give WebKit a deletable character even when the local echo is empty.
export const CAPTURE_SENTINEL = "\u200b";
export const OFF_MODIFIERS: Record<RemoteModifier, ModifierState> = {
  cmd: "off",
  ctrl: "off",
  option: "off",
  shift: "off",
};

export function storedKeyboardMode(): KeyboardMode {
  try {
    return window.localStorage.getItem(KEYBOARD_MODE_STORAGE_KEY) === "native" ? "native" : "deck";
  } catch {
    return "deck";
  }
}

export function storedAutoKeyboard(): boolean {
  try {
    return window.localStorage.getItem(AUTO_KEYBOARD_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}
