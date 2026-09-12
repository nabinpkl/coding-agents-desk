// What the Mac answers: whether the tap landed on something editable, and which of the
// keys already sent it has acknowledged.

import type { DesktopControlEvent } from "@agentdesk/agent-feed-wire";
import {
  appendLocalEcho,
  MAX_RECEIPT_EVENTS,
  receiptToken,
} from "@/features/desktop-viewer/desktopKeyboardModel";
import { clearFocusTimer, clearLocalState, focusCapture, updatePresentation } from "@/features/desktop-viewer/desktopKeyboardSession";
import { acceptEncodedKeys, sendBatch } from "@/features/desktop-viewer/desktopKeyboardSend";
import type { KeyboardContext } from "@/features/desktop-viewer/desktopKeyboardContext";

export function handleControlEvent(ctx: KeyboardContext, event: DesktopControlEvent) {
  if (event.type === "control-revoked") {
    ctx.report({ phase: "control-ownership", detail: { state: "revoked", epoch: event.epoch } });
    clearLocalState(ctx, "hide", "control-revoked");
    return;
  }
  if (event.type === "control-granted") {
    ctx.report({ phase: "control-ownership", detail: { state: "granted", epoch: event.epoch } });
    return;
  }
  if (event.type === "text-focus") {
    if (ctx.presentationRef.current.focusRequestId !== event.focusRequestId) return;
    clearFocusTimer(ctx);
    const started = ctx.focusStarted.current?.requestID === event.focusRequestId
      ? ctx.focusStarted.current.at
      : null;
    ctx.focusStarted.current = null;
    const before = ctx.presentationRef.current.presentation;
    const next = updatePresentation(ctx, { type: "focus-result", event });
    ctx.report({
      phase: "keyboard-focus-result",
      detail: {
        focusRequestId: event.focusRequestId,
        editability: event.editability,
        source: event.source,
        secure: event.secure,
        cursorKind: event.cursorKind,
        latencyMs: started === null ? undefined : Math.round(performance.now() - started),
      },
    });
    if (before === "pending" && next.presentation === "shown") {
      const keys = ctx.pendingKeys.current;
      ctx.pendingKeys.current = [];
      if (keys.length > 0) {
        if (sendBatch(ctx, keys, event.secure)) ctx.setLocalEcho(appendLocalEcho([], keys, event.secure));
        else ctx.setLocalEcho([]);
      }
    } else if (next.presentation === "hidden") {
      clearLocalState(ctx, "hide", "non-editable-focus");
    }
    return;
  }
  if (event.type === "input-applied") {
    const delivery = ctx.pendingDeliveries.current.get(event.sequence);
    if (!delivery) return;
    ctx.pendingDeliveries.current.delete(event.sequence);
    ctx.setReceipt((current) => [...current, ...delivery.tokens].slice(-MAX_RECEIPT_EVENTS));
    ctx.setDeliveryStatus(ctx.pendingDeliveries.current.size > 0 ? "Delivering…" : "Delivered");
    ctx.report({
      phase: "keyboard-input-applied",
      detail: { sequence: event.sequence, count: delivery.tokens.length, secure: delivery.secure },
    });
    return;
  }
  if (event.type === "input-rejected") {
    const delivery = event.sequence === undefined
      ? undefined
      : ctx.pendingDeliveries.current.get(event.sequence);
    if (event.sequence !== undefined) ctx.pendingDeliveries.current.delete(event.sequence);
    ctx.setLocalEcho([]);
    ctx.setDeliveryStatus(`Input rejected: ${event.reason}`);
    ctx.report({
      phase: "keyboard-input-rejected",
      detail: {
        sequence: event.sequence,
        count: delivery?.tokens.length,
        reason: event.reason,
        secure: delivery?.secure ?? ctx.presentationRef.current.secure,
      },
    });
    if (ctx.presentationRef.current.presentation === "pending"
        || event.reason === "accessibility-denied"
        || event.reason === "not-owner") {
      clearLocalState(ctx, "hide", event.reason);
    }
  }
}
