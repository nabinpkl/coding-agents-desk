"use client";

// The composer's action row: send, steer, stop, attach, the mode and model menus, and where each
// is drawn. What sending does is `sessionComposerSubmit.ts`.

import { Braces, ChevronsUpDown, CornerDownLeft, LoaderCircle, Paperclip, Send, ShieldQuestion, Square } from "lucide-react";
import type { ReactNode } from "react";
import type { ClaudePermissionMode } from "@agentdesk/agent-feed-wire";
import type { ChoiceMenuProps } from "@/features/bots/menus/ChoiceMenu";
import type { ComposerModel } from "@/features/session-view/composer/sessionComposerModel";
import { submitComposer, submitOwnedTransport } from "@/features/session-view/composer/sessionComposerSubmit";
import { currentSdkModel } from "@/features/cli-input/useSdkSession";
import { PERMISSION_MODE_ICONS, PERMISSION_MODE_LABELS, permissionModeChoices } from "@/features/cli-input/permissionModes";

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

/**
 * Every band's send, drawn small inside the field's own box at its trailing edge. Margins centre it
 * on a one-line field (48px tall) and keep it pinned to the last line as the field grows.
 */
const SEND_IN_FIELD_CLASS =
  "mb-2 mr-2 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-primary/50 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-40";


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
      onClick: () => document.getElementById(m.filePickerId)?.click(),
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
