"use client";

// Sending, and the action row that offers it.
//
// The two submit paths are separate on purpose: one joins the panel's own queue and can be
// steered, the other hands a whole turn to a transport the panel does not own.

import { ChevronsUpDown, CornerDownLeft, LoaderCircle, Paperclip, Send, ShieldAlert, Square } from "lucide-react";
import type { ClaudePermissionMode } from "@agentdesk/agent-feed-wire";
import type { ComposerAction } from "@/features/session-view/composer/SessionComposer";
import type { ComposerModel } from "@/features/session-view/composer/sessionComposerModel";
import { parseOpencodeCommand } from "@/features/session-view/composer/useOpencodeCommands";
import type { CompactControl } from "@/features/activity-feed/TokenMeter";

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

/** What the chip says for each mode: the words Claude's own footer uses, shortened. */
const PERMISSION_MODE_LABELS: Record<ClaudePermissionMode, string> = {
  auto: "Auto",
  acceptEdits: "Accept edits",
  plan: "Plan",
  bypassPermissions: "Bypass",
  manual: "Manual",
  dontAsk: "Don't ask",
};

const SEND_IN_FIELD_CLASS =
  "mb-2 mr-2 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/50 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * One turn through a transport owned outside the panel's agent-session queue.
 *
 * Separate from `submit` rather than folded into it because the two do different things: this
 * is a delivery to an already-open pty, with no queue to join and nothing to steer. The draft
 * survives a refusal so nothing is lost.
 */
export async function submitOwnedTransport(m: ComposerModel, text = m.editorValue.trim()): Promise<boolean> {
  if (m.deliveryPending || !text) return false;
  m.setDeliveryPending(true);
  m.setDeliveryError(null);
  try {
    if (m.transport.kind === "agent-terminal") {
      await m.transport.terminal.send(text);
      m.setLocalDraft("");
      return true;
    }
    return false;
  } catch (failure) {
    m.setDeliveryError(String((failure as Error).message ?? failure));
    return false;
  } finally {
    m.setDeliveryPending(false);
  }
}

/**
 * The context meter's Compact button: `/compact`, typed where Claude reads commands, so it is
 * exactly what typing it into the session's terminal and pressing Return would do. Null where no
 * door here takes a command -- a native window's field, and the sources that are not Claude or
 * opencode.
 *
 * Never through the CLI inbox, though the composer's Send uses it until the pane is attached. The
 * inbox hands text to the session as a message from a peer, and Claude does not run a slash
 * command that arrives that way: measured, the session received the words `/compact` and
 * compacted nothing. So the button attaches the pane when it is shown, the same way reaching for
 * the field does, and waits for it.
 *
 * Refused over a draft rather than sent in its place. The box holds one value: `/compact` would
 * replace what the reader was writing in the pane itself, and the words would be gone with nowhere
 * to get them back.
 */
export function compactControl(m: ComposerModel): CompactControl | null {
  const opencode = m.session.source === "opencode";
  if (!m.isClaude && !(opencode && m.transport.kind === "agent-session")) return null;
  const busy = m.pending || m.deliveryPending || m.tmuxComposer.pending;
  const draft = m.editorValue.trim()
    ? "Send or clear the draft in the composer first."
    : null;
  if (opencode) {
    return {
      blocked: draft ?? (busy ? "The composer is still sending." : null),
      // The serve reads "/compact" as literal text, so opencode's goes through the command route.
      run: async () => {
        await m.onRunSlash("compact", "");
        return true;
      },
    };
  }
  if (m.tmuxBand || m.agentTerminalBand) {
    return {
      blocked: draft
        ?? (m.tmuxBand && m.tmuxComposer.reason !== null
          ? "This session's terminal can't take input right now."
          : busy ? "The composer is still sending." : null),
      run: async () => m.tmuxBand
        ? await m.tmuxComposer.submit(COMPACT_COMMAND)
        : await submitOwnedTransport(m, COMPACT_COMMAND),
    };
  }
  return {
    blocked: m.tmuxComposer.reason === "no-pane"
      ? "This session has no terminal the panel can type /compact into."
      : "Reaching this session's terminal\u2026",
    prepare: m.engage,
    run: async () => false,
  };
}

const COMPACT_COMMAND = "/compact";

export async function submitComposer(m: ComposerModel, delivery: "next" | "steer"): Promise<void> {
  // Return in the pane, not a delivery: the composer already holds the text, because every
  // keystroke put it there. `submit` on the hook flushes anything still inside the debounce
  // first, so Enter never presses half a sentence.
  if (m.tmuxBand) {
    if (!m.editorValue.trim()) return;
    await m.tmuxComposer.submit();
    return;
  }
  // A terminal session whose pane is not mirrored yet has nowhere to send: the draft waits and
  // moves into the pane's box when the mirror attaches.
  if (m.cliSessionBand) return;
  if (m.agentTerminalBand) {
    await submitOwnedTransport(m);
    return;
  }
  if (m.pending || !m.editorValue.trim()) return;
  const text = m.editorValue.trim();
  // A listed slash command runs natively rather than sending: the serve reads "/name args"
  // as literal text (measured), so only the command route expands the template. Held images
  // stay out of it -- that route takes none -- and ride the next ordinary send instead.
  const slash = m.session.source === "opencode" && m.sendAttachments.images.length === 0
    ? parseOpencodeCommand(m.opencodeCommands, text)
    : null;
  if (slash) {
    // One door, whatever the command is: `/model` opens a dialog here rather than at the sidecar,
    // `/fork` names a session the card then opens, and everything else is a turn. Held images
    // stay out of it -- a command route takes none -- and ride the next ordinary send instead.
    try {
      await m.onRunSlash(slash.name, slash.args);
      m.setLocalDraft("");
    } catch {
      // Same contract as a send: the caption carries the reason, the draft survives.
    }
    return;
  }
  try {
    // Images ride the same request as the text: a turn cannot be amended after it is queued,
    // so holding them for a second call would strand them. Read at send time rather than held,
    // because base64 inflates a photo by a third and the strip already shows it.
    const files = m.session.source === "opencode" && m.sendAttachments.images.length > 0
      ? await m.sendAttachments.toWire(m.sendAttachments.images)
      : undefined;
    await m.onSendMessage(text, delivery, files);
    m.setLocalDraft("");
    m.sendAttachments.clear();
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
  // The mode line under Claude's box, pressed the way Shift+Tab is pressed there. Unknown until the
  // pane's stream attaches -- the transcript only rewrites its mode record now and then -- so the
  // first press attaches it and reads the mode rather than cycling one nobody has seen. Gone once
  // the pane has been looked for and not found, since there is then no footer to drive.
  if (m.isClaude && m.tmuxComposer.reason !== "no-pane") {
    const mode = m.tmuxComposer.permissionMode;
    const label = mode === null ? "Mode" : PERMISSION_MODE_LABELS[mode];
    actions.push({
      key: "permission-mode",
      ariaLabel: mode === null ? "Show this session's permission mode" : `Permission mode ${label}, switch to the next`,
      title: mode === null
        ? "Read this session's permission mode from its terminal"
        : "Switch to the next permission mode, as Shift+Tab does in the terminal",
      icon: (
        <span className="flex min-w-0 items-center gap-1">
          {mode === "bypassPermissions" && <ShieldAlert className="size-3.5 shrink-0" aria-hidden />}
          <span className="block max-w-28 truncate">{label}</span>
        </span>
      ),
      disabled: m.tmuxComposer.pending,
      className: `h-9 min-w-0 rounded-lg px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium hover:bg-muted disabled:opacity-40 ${
        mode === "bypassPermissions" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
      }`,
      placement: "footer",
      onClick: mode === null ? m.engage : m.tmuxComposer.cyclePermissionMode,
    });
  }
  // The TUI's `{agent} · {model}` row, minus the agent: the sidecar names the session's model
  // beside usage, and pressing it opens the picker instead of typing `/model`. Truncated with
  // a selector chevron: on a narrow card the `model · provider` text wraps to two lines and
  // crowds the meter, so it gets one capped line with an ellipsis and the affordance says menu.
  if (m.session.source === "opencode") {
    const [provider, ...rest] = (m.sessionModel ?? "").split("/");
    const label = rest.length > 0 ? `${rest.join("/")} · ${provider}` : "Model";
    actions.push({
      key: "switch-model",
      ariaLabel: m.sessionModel ? `Switch model, currently ${m.sessionModel}` : "Switch model",
      title: "Switch this session's model",
      icon: (
        <span className="flex min-w-0 items-center gap-1">
          <span className="block max-w-36 truncate">{label}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" aria-hidden />
        </span>
      ),
      disabled: m.pending,
      className:
        "h-9 min-w-0 rounded-lg px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted disabled:opacity-40",
      placement: "footer",
      // The same door the command uses, so the button and `/model` are one act rather than two
      // that have to be kept in step.
      onClick: () => void m.onRunSlash("model", ""),
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
} else if (m.cliSessionBand) {
  // No action: nothing is sent from this band. The pane's mirror, once it attaches, brings its own.
} else if (m.agentTerminalBand) {
  // One action, deliberately. Steer and Stop act on a queue the panel owns; a terminal session
  // owns its own, and the person at that keyboard is the one who can interrupt it.
  actions.push({
    key: "send-agent-terminal",
    ariaLabel: "Send through Agent Feed terminal",
    title: "Send through the open Agent Feed terminal",
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
      key: "send",
      ariaLabel: "Stop agent",
      title: "Stop agent",
      icon: m.pending ? (
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
      ) : (
        <Square className="size-3.5 fill-current" aria-hidden />
      ),
      disabled: m.pending,
      className: SEND_IN_FIELD_CLASS,
      placement: "field",
      onClick: () => void m.onAbort(),
    });
  } else {
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
}
  return actions;
}
