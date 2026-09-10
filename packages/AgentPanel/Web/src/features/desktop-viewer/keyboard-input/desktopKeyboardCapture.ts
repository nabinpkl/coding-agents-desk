// The hidden capture field, and what the browser tells us through it.
//
// A textarea nobody sees is how a phone raises its keyboard and how dictation, autocorrect
// and composition arrive at all. Everything here is about reading one of those events
// exactly once and handing it to the send layer.

import type {
  FormEvent,
  ClipboardEvent as ReactClipboardEvent,
  CompositionEvent as ReactCompositionEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { RemoteKeyCode, RemoteModifier } from "@agentdesk/agent-feed-wire";
import {
  KEYBOARD_FOCUS_TIMEOUT_MS,
  REMOTE_MODIFIER_ORDER,
  remoteKeyForCharacter,
  shouldPrimeKeyboard,
} from "@/features/desktop-viewer/keyboard-input/desktopKeyboardModel";
import { CAPTURE_SENTINEL } from "@/features/desktop-viewer/keyboard-input/desktopKeyboardPreferences";
import {
  clearFocusTimer,
  clearLocalState,
  focusCapture,
  hide,
  resetCapture,
  updatePresentation,
} from "@/features/desktop-viewer/keyboard-input/desktopKeyboardSession";
import {
  acceptEncodedKeys,
  acceptText,
  appendToDraft,
  backspaceDraft,
  sendControl,
  sendText,
} from "@/features/desktop-viewer/keyboard-input/desktopKeyboardSend";
import type { KeyboardContext } from "@/features/desktop-viewer/keyboard-input/desktopKeyboardContext";

export function prepareCapture(ctx: KeyboardContext) {
  const state = ctx.presentationRef.current.presentation;
  if (state !== "pending" && state !== "shown") {
    ctx.fullViewportHeight.current = window.visualViewport?.height ?? window.innerHeight;
    ctx.sawKeyboardViewport.current = false;
  }
  resetCapture(ctx);
  focusCapture(ctx);
}

export function beforeRemoteClick(ctx: KeyboardContext): string | undefined {
  if (!ctx.autoKeyboard || !ctx.transportRef.current) return undefined;
  // Refusing here is the whole point: focusing to find out costs a visible show-and-hide of the
  // iOS keyboard on every tap that was never going to type. Without a request id the click still
  // goes to the Mac, the helper never probes, and nothing on this surface moves.
  const kind = ctx.cursorKind();
  if (!shouldPrimeKeyboard(kind)) {
    // Reported under `keyboard-state` rather than a phase of its own: the sidecar's telemetry
    // allowlist is a closed contract, and a refusal to change presentation is a presentation
    // record like any other.
    ctx.report({ phase: "keyboard-state", detail: { event: "prime-skipped", cursorKind: kind } });
    return undefined;
  }
  const focusRequestId = crypto.randomUUID();
  clearFocusTimer(ctx);
  ctx.pendingKeys.current = [];
  ctx.setLocalEcho([]);
  prepareCapture(ctx);
  updatePresentation(ctx, { type: "remote-tap", focusRequestId });
  ctx.focusStarted.current = { requestID: focusRequestId, at: performance.now() };
  ctx.focusTimer.current = window.setTimeout(() => {
    if (ctx.presentationRef.current.focusRequestId !== focusRequestId) return;
    ctx.focusTimer.current = null;
    const started = ctx.focusStarted.current?.requestID === focusRequestId
      ? ctx.focusStarted.current.at
      : null;
    ctx.focusStarted.current = null;
    ctx.report({
      phase: "keyboard-focus-result",
      detail: {
        focusRequestId,
        result: "timeout",
        latencyMs: started === null ? KEYBOARD_FOCUS_TIMEOUT_MS : Math.round(performance.now() - started),
      },
    });
    clearLocalState(ctx, "hide", "focus-timeout");
  }, KEYBOARD_FOCUS_TIMEOUT_MS);
  return focusRequestId;
}

export function consumePointerGesture(ctx: KeyboardContext) {
  if (ctx.presentationRef.current.presentation !== "shown") return false;
  clearLocalState(ctx, "hide", "tile-gesture");
  return true;
}

export function showManually(ctx: KeyboardContext) {
  if (!ctx.transportRef.current) return;
  clearFocusTimer(ctx);
  ctx.pendingKeys.current = [];
  ctx.setLocalEcho([]);
  const focusRequestId = crypto.randomUUID();
  prepareCapture(ctx);
  updatePresentation(ctx, { type: "manual-show", focusRequestId });
  ctx.focusStarted.current = { requestID: focusRequestId, at: performance.now() };
  if (!sendControl(ctx, { type: "focus-query", focusRequestId })) hide(ctx);
}

export function onBeforeInput(ctx: KeyboardContext, input: InputEvent) {
  ctx.handledNativeInput.current = false;
  if (ctx.compositionCommitEcho.current !== null && input.data === ctx.compositionCommitEcho.current) {
    ctx.compositionCommitEcho.current = null;
    input.preventDefault();
    ctx.handledNativeInput.current = !input.cancelable;
    resetCapture(ctx);
    return;
  }
  if (ctx.composing.current || input.isComposing || input.inputType === "insertCompositionText") return;
  let recognized = false;
  if (input.inputType === "deleteContentBackward") {
    recognized = true;
    acceptEncodedKeys(ctx, [{ code: "delete", modifiers: [] }]);
  } else if (input.inputType === "insertLineBreak" || input.inputType === "insertParagraph") {
    recognized = true;
    acceptEncodedKeys(ctx, [{ code: "return", modifiers: [] }]);
  } else if (typeof input.data === "string" && input.data.length > 0) {
    recognized = true;
    acceptText(ctx, input.data);
  }
  if (recognized) {
    input.preventDefault();
    ctx.handledNativeInput.current = !input.cancelable;
    resetCapture(ctx);
  }
}

export function onInput(ctx: KeyboardContext, event: FormEvent<HTMLTextAreaElement>) {
  if (ctx.composing.current) return;
  const input = event.nativeEvent as InputEvent;
  const text = event.currentTarget.value.replace(/^\u200b/, "");
  resetCapture(ctx);
  if (ctx.handledNativeInput.current) {
    ctx.handledNativeInput.current = false;
    return;
  }
  if (ctx.compositionCommitEcho.current !== null && text === ctx.compositionCommitEcho.current) {
    ctx.compositionCommitEcho.current = null;
    return;
  }
  if (input.inputType === "deleteContentBackward") acceptEncodedKeys(ctx, [{ code: "delete", modifiers: [] }]);
  else if (input.inputType === "insertLineBreak" || input.inputType === "insertParagraph") {
    acceptEncodedKeys(ctx, [{ code: "return", modifiers: [] }]);
  } else if (text) acceptText(ctx, text);
}

/**
 * A paste goes as characters, not as key presses.
 *
 * Typing one character at a time can encode it as a US key position and carry modifiers with it.
 * A paste can do neither usefully: it has no modifiers, and iOS has already turned the quotes
 * curly and the double hyphen into an em dash before the clipboard is read, so the key-position
 * encoder refuses the whole insertion. Sending the string itself is the only route that works,
 * and it is also the only one that can carry an emoji or a non-Latin script.
 */
export function onPaste(ctx: KeyboardContext, event: ReactClipboardEvent<HTMLTextAreaElement>) {
  event.preventDefault();
  sendText(ctx, event.clipboardData.getData("text/plain"));
  resetCapture(ctx);
}

export function onCompositionStart(ctx: KeyboardContext) {
  ctx.composing.current = true;
}

export function onCompositionEnd(ctx: KeyboardContext, event: ReactCompositionEvent<HTMLTextAreaElement>) {
  ctx.composing.current = false;
  resetCapture(ctx);
  if (event.data) {
    ctx.compositionCommitEcho.current = event.data;
    window.setTimeout(() => { ctx.compositionCommitEcho.current = null; }, 0);
    acceptText(ctx, event.data);
  }
}

export function onKeyDown(ctx: KeyboardContext, event: ReactKeyboardEvent<HTMLTextAreaElement>) {
  if (ctx.composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
  const controls: Partial<Record<string, RemoteKeyCode>> = {
    Escape: "escape", Tab: "tab", ArrowLeft: "left", ArrowRight: "right",
    ArrowUp: "up", ArrowDown: "down", Backspace: "delete", Enter: "return",
  };
  let key = controls[event.key]
    ? { code: controls[event.key]!, modifiers: [] as RemoteModifier[] }
    : null;
  if (!key && event.key.length === 1 && (event.metaKey || event.ctrlKey || event.altKey)) {
    key = remoteKeyForCharacter(event.key);
  }
  if (!key) return;
  const physical: RemoteModifier[] = [];
  if (event.metaKey) physical.push("cmd");
  if (event.ctrlKey) physical.push("ctrl");
  if (event.altKey) physical.push("option");
  if (event.shiftKey) physical.push("shift");
  key.modifiers = REMOTE_MODIFIER_ORDER.filter((modifier) => (
    physical.includes(modifier) || key!.modifiers.includes(modifier)
  ));
  event.preventDefault();
  event.stopPropagation();
  acceptEncodedKeys(ctx, [key]);
}

/**
 * Losing focus means the browser's keyboard went away, so stop presenting -- but only while the
 * browser's keyboard is the one typing. With the deck, an unfocused capture is the resting
 * state, and the blur that comes from switching back to it is not a dismissal.
 */
export function onBlur(ctx: KeyboardContext) {
  if (ctx.blurTimer.current !== null) window.clearTimeout(ctx.blurTimer.current);
  ctx.blurTimer.current = window.setTimeout(() => {
    ctx.blurTimer.current = null;
    if (ctx.showsDeckRef.current) return;
    if (document.activeElement !== ctx.captureRef.current
        && (ctx.presentationRef.current.presentation === "shown"
          || ctx.presentationRef.current.presentation === "pending")) clearLocalState(ctx, "hide", "dom-blur");
  }, 0);
}
