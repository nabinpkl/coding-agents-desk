// Putting input on the control channel: one key batch or one string at a time, what the
// panel shows while it is in flight, and the draft a pasted block is edited in first.

import {
  DESKTOP_CONTROL_MAX_KEY_BATCH,
  DESKTOP_CONTROL_MAX_MESSAGE_BYTES,
  DESKTOP_CONTROL_MAX_TEXT_UNITS,
  type DesktopControlInput,
  type RemoteKeyCode,
  type RemoteKeyEvent,
  type RemoteModifier,
} from "@agentdesk/agent-feed-wire";
import {
  activeModifiers,
  appendLocalEcho,
  clearArmedModifiers,
  cycleModifier,
  MAX_PENDING_KEY_EVENTS,
  MAX_RECEIPT_EVENTS,
  receiptToken,
  remoteKeyForCharacter,
  remoteKeysForText,
} from "@/features/desktop-viewer/keyboard-input/desktopKeyboardModel";
import { clearLocalState, focusCapture } from "@/features/desktop-viewer/keyboard-input/desktopKeyboardSession";
import type { KeyboardContext } from "@/features/desktop-viewer/keyboard-input/desktopKeyboardContext";

export function sendControl(ctx: KeyboardContext, input: DesktopControlInput): boolean {
  const result = ctx.transportRef.current?.send(input) ?? "channel-closed";
  const accepted = result === "sent";
  if (!accepted) ctx.lastSendFailure.current = result;
  if (!accepted && input.type === "click" && input.focusRequestId) {
    ctx.report({
      phase: "keyboard-input-rejected",
      detail: { focusRequestId: input.focusRequestId, reason: result },
    });
    clearLocalState(ctx, "hide", result);
  }
  return accepted;
}

export function nextInputSequence(ctx: KeyboardContext): number {
  const sequence = ctx.nextSequence.current;
  ctx.nextSequence.current = sequence === 0xffff_ffff ? 1 : sequence + 1;
  return sequence;
}

export function sendBatch(ctx: KeyboardContext, keys: RemoteKeyEvent[], secure: boolean): boolean {
  const sequence = nextInputSequence(ctx);
  const input: DesktopControlInput = { type: "key-batch", sequence, keys };
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > DESKTOP_CONTROL_MAX_MESSAGE_BYTES) {
    ctx.setDeliveryStatus("Input not sent: batch exceeds control limit");
    ctx.report({
      phase: "keyboard-input-rejected",
      detail: { sequence, count: keys.length, reason: "oversized", secure },
    });
    return false;
  }
  ctx.pendingDeliveries.current.set(sequence, { tokens: keys.map((key) => receiptToken(key, secure)), secure });
  if (!sendControl(ctx, input)) {
    ctx.pendingDeliveries.current.delete(sequence);
    ctx.setDeliveryStatus("Input not sent: control channel unavailable");
    ctx.report({
      phase: "keyboard-input-rejected",
      detail: { sequence, count: keys.length, reason: ctx.lastSendFailure.current, secure },
    });
    return false;
  }
  ctx.setDeliveryStatus("Delivering…");
  return true;
}

/**
 * Send a whole string at once, as characters rather than as key presses.
 *
 * The per-keystroke path encodes each character as a US key position, and rejects the entire
 * insertion when one character has no such position: a pasted paragraph from a phone, where iOS
 * has already turned the quotes curly and the double hyphen into an em dash, fails as a whole.
 * This path carries the characters themselves, so what can be pasted is whatever Unicode has.
 *
 * It does not carry modifiers, which is the trade: a chord is still a key-batch.
 */
export function sendText(ctx: KeyboardContext, text: string): boolean {
  if (text.length === 0) return false;
  const secure = ctx.presentationRef.current.secure;
  const sequence = nextInputSequence(ctx);
  const input: DesktopControlInput = { type: "text", sequence, text };
  if (
    text.length > DESKTOP_CONTROL_MAX_TEXT_UNITS ||
    new TextEncoder().encode(JSON.stringify(input)).byteLength > DESKTOP_CONTROL_MAX_MESSAGE_BYTES
  ) {
    ctx.setDeliveryStatus("Text not sent: too long for one send");
    ctx.report({
      phase: "keyboard-input-rejected",
      detail: { sequence, count: text.length, reason: "oversized", secure },
    });
    return false;
  }
  // No receipt tokens: the echo strip mirrors keystrokes, and a paste is not keystrokes. Its
  // delivery is reported by the status line instead.
  ctx.pendingDeliveries.current.set(sequence, { tokens: [], secure });
  if (!sendControl(ctx, input)) {
    ctx.pendingDeliveries.current.delete(sequence);
    ctx.setDeliveryStatus("Text not sent: control channel unavailable");
    ctx.report({
      phase: "keyboard-input-rejected",
      detail: { sequence, count: text.length, reason: ctx.lastSendFailure.current, secure },
    });
    return false;
  }
  ctx.setDeliveryStatus("Delivering…");
  return true;
}

/**
 * Put the clipboard on the Mac without any field here taking focus.
 *
 * The obvious shape -- a text box you paste into -- cannot work in a browser tab. WebKit draws
 * its form-navigation strip whenever a field big enough to tap holds focus, that strip lands on
 * top of the panel's own key rail, and no web API removes it; the native containers suppress it
 * with `inputAccessoryView`, and a browser has no such lever. Reading the clipboard on a button
 * press needs no focused field, so the strip never appears. iOS answers the read with its own
 * paste confirmation, which is the platform's own privacy prompt and not something to route
 * around.
 */
export async function pasteFromClipboard(ctx: KeyboardContext): Promise<void> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.readText) {
    ctx.setDeliveryStatus("Paste unavailable: this browser will not read the clipboard");
    return;
  }
  let text: string;
  try {
    text = await clipboard.readText();
  } catch {
    // Denied, dismissed, or read outside the gesture. All three are the same to the viewer.
    ctx.setDeliveryStatus("Paste not allowed: nothing was read");
    return;
  }
  if (text.length === 0) {
    ctx.setDeliveryStatus("Clipboard is empty: nothing was sent");
    return;
  }
  // With the deck up there is a keyboard to edit with, so the paste lands in a draft and waits.
  // Without one there is nothing to edit it with, and it goes as it always did.
  if (ctx.showsDeckRef.current) {
    ctx.setDeliveryStatus(null);
    ctx.setDraft(text);
    return;
  }
  sendText(ctx, text);
}

export function appendToDraft(ctx: KeyboardContext, character: string) {
  ctx.setDraft((current) => (current === null ? current : current + character));
}

export function backspaceDraft(ctx: KeyboardContext) {
  // By code point, so one backspace takes one emoji rather than half of one.
  ctx.setDraft((current) => (current === null ? current : [...current].slice(0, -1).join("")));
}

export function cancelDraft(ctx: KeyboardContext) {
  ctx.setDraft(null);
  ctx.setDeliveryStatus(null);
}

/** Commit the edited text and leave the mode. It goes as characters, which is what a paste is. */
export function sendDraft(ctx: KeyboardContext) {
  const text = ctx.draftRef.current;
  if (text === null) return;
  ctx.setDraft(null);
  if (text.length === 0) return;
  sendText(ctx, text);
}

export function decorateWithStickyModifiers(ctx: KeyboardContext, keys: RemoteKeyEvent[]): RemoteKeyEvent[] {
  let states = ctx.modifiersRef.current;
  return keys.map((key) => {
    const next = { ...key, modifiers: activeModifiers(states, key.modifiers) };
    states = clearArmedModifiers(states);
    return next;
  });
}

export function acceptEncodedKeys(ctx: KeyboardContext, keys: RemoteKeyEvent[]): boolean {
  if (keys.length === 0) return true;
  if (keys.length > DESKTOP_CONTROL_MAX_KEY_BATCH) {
    ctx.setDeliveryStatus("Input not sent: insertion is too long");
    ctx.report({
      phase: "keyboard-input-rejected",
      detail: { count: keys.length, reason: "oversized" },
    });
    return false;
  }
  const state = ctx.presentationRef.current;
  if (state.presentation !== "pending" && state.presentation !== "shown") return false;
  if (state.presentation === "pending" && ctx.pendingKeys.current.length + keys.length > MAX_PENDING_KEY_EVENTS) {
    ctx.setDeliveryStatus("Input not sent: focus buffer full");
    ctx.report({
      phase: "keyboard-buffer-overflow",
      detail: {
        focusRequestId: state.focusRequestId,
        pendingCount: ctx.pendingKeys.current.length,
        rejectedCount: keys.length,
      },
    });
    return false;
  }
  const decorated = decorateWithStickyModifiers(ctx, keys);
  if (state.presentation === "pending") {
    ctx.pendingKeys.current.push(...decorated);
    ctx.setDeliveryStatus("Waiting for focus…");
  } else if (!sendBatch(ctx, decorated, state.secure || state.editability === null)) {
    return false;
  }
  const nextModifiers = clearArmedModifiers(ctx.modifiersRef.current);
  ctx.modifiersRef.current = nextModifiers;
  ctx.setModifiers(nextModifiers);
  ctx.setLocalEcho((current) => appendLocalEcho(current, decorated, state.secure || state.editability === null));
  return true;
}

export function acceptText(ctx: KeyboardContext, text: string): boolean {
  const encoded = remoteKeysForText(text);
  if (!encoded) {
    ctx.setDeliveryStatus("Unsupported character: nothing was sent");
    ctx.report({
      phase: "keyboard-input-rejected",
      detail: { reason: "unknown-key", count: [...text].length },
    });
    return false;
  }
  return acceptEncodedKeys(ctx, encoded);
}

/**
 * One character from the on-screen deck.
 *
 * Most of them are a US key position and go as one, which is what carries the armed modifiers
 * and fills the echo strip. The symbols page also offers four that no US keyboard has a key for
 * -- the currency signs and the bullet -- and those go as characters instead, since a key code
 * that does not exist cannot be sent. Their echo is appended here because the text path
 * deliberately reports no keystroke tokens of its own.
 */
export function sendDeckCharacter(ctx: KeyboardContext, character: string): boolean {
  // A draft is a mode, so the deck types into it rather than at the Mac. Return is the exception
  // and the way out: it sends what has been edited.
  if (ctx.draftRef.current !== null) {
    if (character === "\n") {
      sendDraft(ctx);
      return true;
    }
    appendToDraft(ctx, character);
    return true;
  }
  const key = remoteKeyForCharacter(character);
  if (key) return acceptEncodedKeys(ctx, [key]);
  const secure = ctx.presentationRef.current.secure || ctx.presentationRef.current.editability === null;
  if (!sendText(ctx, character)) return false;
  ctx.setLocalEcho((current) => [...current, secure ? "\u2022" : character].slice(-MAX_RECEIPT_EVENTS));
  return true;
}

/** Panning the deck's space bar moves the remote caret, one arrow press per step. */
export function sendDeckCursorDelta(ctx: KeyboardContext, delta: number) {
  const code: RemoteKeyCode = delta > 0 ? "right" : "left";
  const steps = Math.min(Math.abs(delta), DESKTOP_CONTROL_MAX_KEY_BATCH);
  acceptEncodedKeys(
    ctx,
    Array.from({ length: steps }, () => ({ code, modifiers: [] })),
  );
}

export function sendChromeKey(ctx: KeyboardContext, code: RemoteKeyCode) {
  acceptEncodedKeys(ctx, [{ code, modifiers: [] }]);
  focusCapture(ctx);
}

/** Backspace edits the draft while there is one, and reaches the Mac only when there is not. */
export function deckBackspace(ctx: KeyboardContext) {
  if (ctx.draftRef.current !== null) {
    backspaceDraft(ctx);
    return;
  }
  sendChromeKey(ctx, "delete");
}

export function tapModifier(ctx: KeyboardContext, modifier: RemoteModifier) {
  const next = { ...ctx.modifiersRef.current };
  next[modifier] = cycleModifier(next[modifier]);
  ctx.modifiersRef.current = next;
  ctx.setModifiers(next);
  focusCapture(ctx);
}
