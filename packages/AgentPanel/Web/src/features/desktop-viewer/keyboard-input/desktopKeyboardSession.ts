// The keyboard's own state changes: which keyboard is showing, what the presentation
// reducer was told, and everything that has to be forgotten when it goes away.

import {
  INITIAL_KEYBOARD_PRESENTATION,
  keyboardPresentationReducer,
  type KeyboardPresentationAction,
} from "@/features/desktop-viewer/keyboard-input/desktopKeyboardModel";
import {
  AUTO_KEYBOARD_STORAGE_KEY,
  CAPTURE_SENTINEL,
  KEYBOARD_MODE_STORAGE_KEY,
  OFF_MODIFIERS,
} from "@/features/desktop-viewer/keyboard-input/desktopKeyboardPreferences";
import type { KeyboardContext, KeyboardMode } from "@/features/desktop-viewer/keyboard-input/desktopKeyboardContext";

export function resetCapture(ctx: KeyboardContext) {
  const capture = ctx.captureRef.current;
  if (!capture) return;
  capture.value = CAPTURE_SENTINEL;
  capture.setSelectionRange(CAPTURE_SENTINEL.length, CAPTURE_SENTINEL.length);
}

/**
 * Focus the capture field only where focusing it is the way text arrives.
 *
 * With the browser's keyboard that is exactly what it is: a desktop browser's physical keys need
 * a focused element to land in, and a phone raises its software keyboard from the focus. With
 * the deck it is the opposite -- a focused editable is what summons WebKit's form-navigation
 * strip, which no web API can remove -- so the deck leaves everything unfocused.
 */
export function focusCapture(ctx: KeyboardContext) {
  if (ctx.showsDeckRef.current) return;
  ctx.captureRef.current?.focus({ preventScroll: true });
}

/**
 * Switch which keyboard types, and act on it in the same call.
 *
 * Raising WebKit's keyboard needs a focus inside the tap's own gesture, so this cannot wait for
 * the render that follows the state change; the ref is updated here for the same reason, so a
 * `focusCapture` between now and that render already knows which keyboard is showing.
 */
export function setKeyboardMode(ctx: KeyboardContext, mode: KeyboardMode) {
  ctx.setKeyboardModeState(mode);
  ctx.showsDeckRef.current = ctx.deckAvailable && mode === "deck";
  try {
    window.localStorage.setItem(KEYBOARD_MODE_STORAGE_KEY, mode);
  } catch {
    // The current setting remains authoritative for this mounted surface.
  }
  if (ctx.showsDeckRef.current) {
    // The browser's keyboard is on its way out; nothing left of it should be able to fire.
    ctx.sawKeyboardViewport.current = false;
    ctx.setSoftwareKeyboardVisible(false);
    ctx.captureRef.current?.blur();
    return;
  }
  resetCapture(ctx);
  ctx.captureRef.current?.focus({ preventScroll: true });
}

export function updatePresentation(ctx: KeyboardContext, action: KeyboardPresentationAction) {
  const previous = ctx.presentationRef.current;
  const next = keyboardPresentationReducer(previous, action);
  ctx.presentationRef.current = next;
  ctx.setPresentation(next);
  if (next !== previous) {
    ctx.report({
      phase: "keyboard-state",
      detail: {
        from: previous.presentation,
        to: next.presentation,
        focusRequestId: next.focusRequestId,
        secure: next.secure,
        cause: action.type,
      },
    });
  }
  return next;
}

export function clearFocusTimer(ctx: KeyboardContext) {
  if (ctx.focusTimer.current !== null) window.clearTimeout(ctx.focusTimer.current);
  ctx.focusTimer.current = null;
}

export function clearLocalState(ctx: KeyboardContext, action: "hide" | "transport-close", reason: string = action) {
  if (ctx.presentationRef.current.presentation === "pending" || ctx.presentationRef.current.presentation === "shown") {
    ctx.report({ phase: "keyboard-state", detail: { event: "dismiss", reason } });
  }
  clearFocusTimer(ctx);
  ctx.pendingKeys.current = [];
  ctx.pendingDeliveries.current.clear();
  ctx.focusStarted.current = null;
  ctx.modifiersRef.current = OFF_MODIFIERS;
  ctx.setModifiers(OFF_MODIFIERS);
  ctx.setReceipt([]);
  ctx.setLocalEcho([]);
  ctx.setDeliveryStatus(null);
  ctx.composing.current = false;
  ctx.compositionCommitEcho.current = null;
  ctx.handledNativeInput.current = false;
  ctx.sawKeyboardViewport.current = false;
  ctx.setSoftwareKeyboardVisible(false);
  updatePresentation(ctx, { type: action });
  if (ctx.captureRef.current) {
    ctx.captureRef.current.value = "";
    ctx.captureRef.current.blur();
  }
}

export function hide(ctx: KeyboardContext): void {
  clearLocalState(ctx, "hide", "explicit-hide");
}

export function setAutoKeyboard(ctx: KeyboardContext, enabled: boolean) {
  ctx.setAutoKeyboardState(enabled);
  try {
    window.localStorage.setItem(AUTO_KEYBOARD_STORAGE_KEY, String(enabled));
  } catch {
    // The current setting remains authoritative for this mounted surface.
  }
}
