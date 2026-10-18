"use client";

// Sending, and the action row that offers it.
//
// The two submit paths are separate on purpose: one joins the panel's own queue and can be
// steered, the other hands a whole turn to a transport the panel does not own.

import { Braces, ChevronsUpDown, CornerDownLeft, LoaderCircle, Paperclip, Send, ShieldQuestion, Square } from "lucide-react";
import type { ReactNode } from "react";
import type { ClaudePermissionMode } from "@agentdesk/agent-feed-wire";
import type { ChoiceMenuProps } from "@/features/bots/menus/ChoiceMenu";
import type { ComposerModel } from "@/features/session-view/composer/sessionComposerModel";
import { parseOpencodeCommand } from "@/features/session-view/composer/useOpencodeCommands";
import { currentSdkModel } from "@/features/cli-input/useSdkSession";
import { PERMISSION_MODE_ICONS, PERMISSION_MODE_LABELS, permissionModeChoices } from "@/features/cli-input/permissionModes";
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

/** One action in the composer, rendered in array order in the place its `placement` names. */
export type ComposerAction = {
  key: string;
  ariaLabel: string;
  title: string;
  icon: ReactNode;
  disabled: boolean;
  className: string;
  /**
   * Where it is drawn. Omitted is the row beside the field; `field` is inside it at its trailing
   * edge (the send); `footer` is the small line under it, beside the context meter.
   */
  placement?: "field" | "footer";
  /** Set on a toggle: drawn in the active colour while on, and announced as pressed. */
  pressed?: boolean;
} & (
  | { onClick: () => void; menu?: undefined }
  /** Opens a pick-one menu (`ChoiceMenu`) instead of doing anything itself. */
  | { menu: Omit<ChoiceMenuProps<string>, "trigger">; onClick?: undefined }
);

const SEND_IN_FIELD_CLASS =
  "mb-2 mr-2 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/50 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-40";

/**
 * One turn through a transport owned outside the panel's agent-session queue.
 *
 * Separate from `submit` rather than folded into it because the two do different things: this
 * is a delivery to an already-open pty, with no queue to join and nothing to steer. The draft
 * survives a refusal so nothing is lost.
 */
export async function submitOwnedTransport(
  m: ComposerModel,
  text = m.editorValue.trim(),
  /** Whether the images held in the band ride this send: yes for the reader's turn, no for a command. */
  withImages = true,
): Promise<boolean> {
  if (m.deliveryPending || !text) return false;
  m.setDeliveryPending(true);
  m.setDeliveryError(null);
  try {
    if (m.transport.kind === "sdk-session") {
      // Read at send time rather than held as base64, for the reason the opencode send gives.
      const images = withImages ? m.sendAttachments.images : [];
      const files = images.length > 0 ? await m.sendAttachments.toWire(images) : undefined;
      // The runner says why when it refuses (`sdkSession.error`), and the draft and images stay.
      const sent = await m.sdkSession.send(text, files);
      if (sent) {
        m.setLocalDraft("");
        if (images.length > 0) m.sendAttachments.clear();
      }
      return sent;
    }
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
  if (m.sdkBand) {
    return {
      blocked: draft ?? (!m.sdkSession.state.connected
        ? "This session is not running."
        : busy || m.sdkSession.pending ? "The composer is still sending." : null),
      // A slash command is a turn the CLI runs rather than reads, through the SDK as at a keyboard.
      run: async () => await submitOwnedTransport(m, COMPACT_COMMAND, false),
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
  // An SDK session's runner queues a turn sent while one runs, as the terminal does.
  if (m.sdkBand) {
    await submitOwnedTransport(m);
    return;
  }
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
  // The SDK toggle: braces, drawn in the active colour while the session runs through the SDK
  // runner and muted while it runs in the terminal; pressing it moves the session to the other way,
  // in its own pane. Whether it is idle enough is the sidecar's to say, and it says why not.
  if (m.runMode === "terminal" || (m.runMode === "sdk" && m.sdkSession.state.connected)) {
    const onSdk = m.runMode === "sdk";
    const target = onSdk ? "terminal" : "sdk";
    actions.push({
      key: "switch-run-mode",
      ariaLabel: onSdk ? "Running through the SDK, move to the terminal" : "Running in the terminal, move to the SDK",
      title: onSdk
        ? "Running through the SDK. Move this idle session back to the terminal, in the same pane"
        : "Running in the terminal. Move this idle session to the SDK runner, in the same pane",
      pressed: onSdk,
      icon: m.runModeSwitch.pending
        ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        : <Braces className="size-3.5" aria-hidden />,
      disabled: m.runModeSwitch.pending,
      className: `${COMPOSER_FOOTER_BUTTON_CLASS} ${onSdk ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`,
      placement: "footer",
      onClick: () => void m.runModeSwitch.switchTo(target),
    });
  }
  // The permission mode: a chip naming it, which opens the list to choose another. An SDK
  // session's runner sets the choice directly; a terminal's gets there by Shift+Tab, which the
  // sidecar presses until the footer names it. A terminal's mode is unknown until the pane's stream
  // attaches -- the transcript only rewrites its mode record now and then -- so until then the chip
  // attaches it and reads the mode. Gone once the pane has been looked for and not found.
  if (m.isClaude && (m.sdkBand || m.tmuxComposer.reason !== "no-pane")) {
    const mode = m.sdkBand ? m.sdkSession.state.permissionMode : m.tmuxComposer.permissionMode;
    const label = mode === null ? "Mode" : PERMISSION_MODE_LABELS[mode];
    const Icon = mode === null ? ShieldQuestion : PERMISSION_MODE_ICONS[mode];
    const chip = {
      key: "permission-mode",
      // Below the footer's `@[420px]` width only the mode's icon shows; the label and the chooser's
      // chevron come back where there is room. The aria-label and title name the mode either way.
      icon: (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <Icon className="size-3.5 shrink-0" aria-hidden />
          <span className="hidden @[420px]:inline">{label}</span>
          {m.sdkBand || mode !== null ? <ChevronsUpDown className="hidden size-3 shrink-0 opacity-60 @[420px]:block" aria-hidden /> : null}
        </span>
      ),
      // Not squeezed: a mode cut to "B…" hides the one fact the chip is there to show.
      className: `h-9 shrink-0 rounded-lg px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium hover:bg-muted disabled:opacity-40 ${
        mode === "bypassPermissions" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
      }`,
      placement: "footer" as const,
    };
    if (!m.sdkBand && mode === null) {
      actions.push({
        ...chip,
        ariaLabel: "Show this session's permission mode",
        title: "Read this session's permission mode from its terminal",
        disabled: m.tmuxComposer.pending,
        onClick: m.engage,
      });
    } else {
      actions.push({
        ...chip,
        ariaLabel: `Permission mode ${label}, choose another`,
        title: "Choose this session's permission mode",
        disabled: m.sdkBand ? !m.sdkSession.state.connected || m.sdkSession.pending : m.tmuxComposer.pending,
        menu: {
          label: "Permission mode",
          value: mode,
          // Bypass is refused only where that is known: an SDK runner says whether it was started
          // allowing it, a terminal says so by its Shift+Tab never reaching it.
          choices: permissionModeChoices(m.sdkBand ? m.sdkSession.state.allowBypass : true),
          onChoose: (value) => {
            const next = value as ClaudePermissionMode;
            void (m.sdkBand ? m.sdkSession.choosePermissionMode(next) : m.tmuxComposer.choosePermissionMode(next));
          },
        },
      });
    }
  }
  // An SDK session's model, from its runner: what the CLI says it answers with, switched through the
  // same picker opencode's uses, from the models that `claude` offers.
  if (m.sdkBand && m.sdkSession.state.connected && m.sdkSession.state.models.length > 0) {
    const current = currentSdkModel(m.sdkSession.state);
    const label = current?.displayName ?? m.sdkSession.state.model ?? "Model";
    actions.push({
      key: "switch-model",
      ariaLabel: `Switch model, currently ${label}`,
      title: "Switch this session's model, from its next turn",
      icon: (
        <span className="flex min-w-0 items-center gap-1">
          <span className="block max-w-36 truncate">{label}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-60" aria-hidden />
        </span>
      ),
      disabled: false,
      className:
        "h-9 min-w-0 rounded-lg px-2 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground hover:bg-muted disabled:opacity-40",
      placement: "footer",
      onClick: () => void m.onRunSlash("model", ""),
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
} else if (m.sdkBand) {
  // Stop while a turn runs, since nothing else can interrupt a session with no screen; Send
  // otherwise. Return still sends during a turn, which the runner queues behind it.
  const status = m.sdkSession.state.status;
  if (status === "running" || status === "requires-action") {
    actions.push({
      key: "stop-sdk",
      ariaLabel: "Stop this turn",
      title: "Interrupt the turn this session is running",
      icon: m.sdkSession.pending
        ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        : <Square className="size-3.5 fill-current" aria-hidden />,
      disabled: m.sdkSession.pending,
      className: SEND_IN_FIELD_CLASS,
      placement: "field",
      onClick: () => void m.sdkSession.interrupt(),
    });
  } else {
    actions.push({
      key: "send-sdk",
      ariaLabel: "Send message",
      title: "Send to this session",
      icon: m.deliveryPending
        ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        : <Send className="size-3.5" aria-hidden />,
      disabled: m.unavailable || m.deliveryPending || !m.editorValue.trim(),
      className: SEND_IN_FIELD_CLASS,
      placement: "field",
      onClick: () => void submitOwnedTransport(m),
    });
  }
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
