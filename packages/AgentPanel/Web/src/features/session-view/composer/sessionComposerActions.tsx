"use client";

// Sending, and the action row that offers it.
//
// The two submit paths are separate on purpose: one joins the panel's own queue and can be
// steered, the other hands a whole turn to a transport the panel does not own.

import { CornerDownLeft, LoaderCircle, Paperclip, Send, Square } from "lucide-react";
import type { ComposerAction } from "@/features/session-view/composer/SessionComposer";
import type { ComposerModel } from "@/features/session-view/composer/sessionComposerModel";

/**
 * Every band's send, drawn small inside the field's own box at its trailing edge. Margins centre it
 * on a one-line field (48px tall) and keep it pinned to the last line as the field grows.
 */
/**
 * The small icon buttons on the line under the field, beside the context meter: attach, and the
 * terminal toggle the band draws itself. Colour is left to the caller, which is how the toggle
 * shows its pressed state without two text colours fighting in one class list. A translucent
 * hover rather than `bg-muted`, so it darkens whatever tinted dock it sits on.
 */
export const COMPOSER_FOOTER_BUTTON_CLASS =
  "flex size-7 shrink-0 touch-manipulation items-center justify-center rounded-md outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-primary active:bg-foreground/15 disabled:cursor-not-allowed disabled:opacity-40";

const SEND_IN_FIELD_CLASS =
  "mb-2 mr-2 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/50 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * One turn through a transport owned outside the panel's agent-session queue.
 *
 * Separate from `submit` rather than folded into it because the two do different things: this
 * is a delivery to a CLI inbox or an already-open pty, with no queue to join and nothing to
 * steer. The draft survives a refusal so nothing is lost.
 */
export async function submitOwnedTransport(m: ComposerModel): Promise<void> {
  if (m.deliveryPending || !m.editorValue.trim()) return;
  const text = m.editorValue.trim();
  m.setDeliveryPending(true);
  m.setDeliveryError(null);
  try {
    if (m.transport.kind === "agent-terminal") {
      await m.transport.terminal.send(text);
      m.setLocalDraft("");
    } else if (m.transport.kind === "cli-inbox" && await m.cliInput.send(text)) {
      m.setLocalDraft("");
    }
  } catch (failure) {
    m.setDeliveryError(String((failure as Error).message ?? failure));
  } finally {
    m.setDeliveryPending(false);
  }
}

export async function submitComposer(m: ComposerModel, delivery: "next" | "steer"): Promise<void> {
  // Return in the pane, not a delivery: the composer already holds the text, because every
  // keystroke put it there. `submit` on the hook flushes anything still inside the debounce
  // first, so Enter never presses half a sentence.
  if (m.tmuxBand) {
    if (!m.editorValue.trim()) return;
    return await m.tmuxComposer.submit();
  }
  if (m.inboxBand || m.agentTerminalBand) return await submitOwnedTransport(m);
  if (m.pending || !m.editorValue.trim()) return;
  const text = m.editorValue.trim();
  try {
    await m.onSendMessage(text, delivery);
    m.setLocalDraft("");
  } catch {
    // The shell's caption carries the reason; keep the draft so nothing is lost.
  }
}

export function composerActions(m: ComposerModel): ComposerAction[] {
  const actions: ComposerAction[] = [];
  // Offered wherever an image has somewhere to go, which is the same rule the card's drop target
  // follows and not the band that happens to be attached. It used to be pushed inside the tmux
  // branch, so it appeared the moment the field took focus and the mirror took the band over --
  // a session nobody had typed in yet showed no way to attach anything, though dropping on it
  // worked the whole time.
  if (m.acceptFiles) {
    // Under the field, beside the context meter: the field's own trailing edge is Send's.
    actions.push({
      key: "attach-image",
      ariaLabel: "Add an image to this session's composer",
      title: "Put an image in this session's terminal composer",
      icon: <Paperclip className="size-3.5" aria-hidden />,
      disabled: m.tmuxComposer.pending,
      className: `${COMPOSER_FOOTER_BUTTON_CLASS} text-muted-foreground hover:text-foreground`,
      placement: "footer",
      onClick: () => m.filePicker.current?.click(),
    });
  }
if (m.windowBand) {
  // The window band's only explicit action is the Enter button: filling and
  // reading are automatic (focus prefill, debounced sync, one round trip for
  // an off-Desktop window), so there is nothing left to button.
  actions.push({
    key: "submit-window",
    ariaLabel: m.isCodex ? "Send to Codex's composer" : "Send to Claude's composer",
    title: m.isCodex
      ? "Fill and press Enter in Codex, sending the prompt now"
      : "Fill and press Enter in Claude, sending the prompt now",
    icon: m.windowComposer.pending ? (
      <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
    ) : (
      <CornerDownLeft className="size-3.5" aria-hidden />
    ),
    disabled: !m.windowComposer.canSubmit || m.windowComposer.pending,
    className: SEND_IN_FIELD_CLASS,
    placement: "field",
    onClick: () => void m.windowComposer.submitWindow(),
  });
} else if (m.tmuxBand) {
  // One action, like the bands below it and for the same reason: Steer and Stop act
  // on a queue the panel owns, and this session owns its own.
  actions.push({
    key: "send-tmux-composer",
    ariaLabel: "Send in this session's terminal",
    title: "Press Return in this session's terminal, sending what its composer holds",
    icon: m.tmuxComposer.pending ? (
      <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
    ) : (
      <CornerDownLeft className="size-3.5" aria-hidden />
    ),
    disabled: m.tmuxComposer.pending || !m.editorValue.trim(),
    className: SEND_IN_FIELD_CLASS,
    placement: "field",
    onClick: () => void m.tmuxComposer.submit(),
  });
} else if (m.inboxBand || m.agentTerminalBand) {
  // One action, deliberately. Steer and Stop act on a queue the panel owns; a terminal session
  // owns its own, and the person at that keyboard is the one who can interrupt it.
  actions.push({
    key: m.agentTerminalBand ? "send-agent-terminal" : "send-inbox",
    ariaLabel: m.agentTerminalBand ? "Send through Agent Feed terminal" : "Send to the terminal session",
    title: m.agentTerminalBand ? "Send through the open Agent Feed terminal" : "Send to the terminal session",
    icon: m.deliveryPending ? (
      <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
    ) : (
      <Send className="size-3.5" aria-hidden />
    ),
    disabled: m.unavailable || m.deliveryPending || !m.editorValue.trim(),
    className: SEND_IN_FIELD_CLASS,
    placement: "field",
    onClick: () => void submitOwnedTransport(m),
  });
} else if (!m.unavailable) {
  if (m.running && m.capabilities.canSteer) {
    actions.push({
      key: "steer",
      ariaLabel: "Steer",
      title: "Steer",
      icon: <span>Steer</span>,
      disabled: m.pending || !m.editorValue.trim(),
      className:
        "h-9 rounded-lg px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted disabled:opacity-40",
      onClick: () => void submitComposer(m, "steer"),
    });
  }
  if (m.running && m.capabilities.canAbort) {
    actions.push({
      key: "abort",
      ariaLabel: "Stop agent",
      title: "Stop agent",
      icon: <Square className="size-3.5 fill-current" aria-hidden />,
      disabled: m.pending,
      className:
        "flex size-11 items-center justify-center rounded-xl text-destructive hover:bg-destructive/10 disabled:opacity-40",
      onClick: () => void m.onAbort(),
    });
  }
  actions.push({
    key: "send",
    ariaLabel: m.running ? "Queue message" : "Send message",
    title: m.running ? "Queue message" : "Send message",
    icon: m.pending ? (
      <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
    ) : (
      <Send className="size-3.5" aria-hidden />
    ),
    disabled: m.pending || !m.editorValue.trim(),
    className: SEND_IN_FIELD_CLASS,
    placement: "field",
    onClick: () => void submitComposer(m, "next"),
  });
}
  return actions;
}
