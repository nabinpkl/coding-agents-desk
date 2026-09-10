// What the field is, in whichever band is showing: its value, its placeholder, what Tab
// does, and what a dropped file means.

import type {
  ComposerCommand,
  RailKey,
  RailModifier,
} from "@agentdesk/agent-feed-wire";
import type { ModifierState } from "@/features/keyboard/modifierLatch";
import type { ComposerImage } from "@/features/cli-input/useTmuxComposer";
import { cliInputReasonText } from "@/features/cli-input/useCliInput";
import { tmuxComposerReasonText } from "@/features/cli-input/useTmuxComposer";
import { harnessName } from "@/features/session-view/SessionView";
import type { ComposerModel } from "@/features/session-view/sessionComposerModel";

export interface ComposerEditor {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  ariaLabel: string;
  placeholder: string;
  maxLength: number;
  sendOnEnter: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  /**
   * What Tab does instead of moving focus, when there is something to accept.
   *
   * Only the mirrored terminal band has one: it is the only field whose placeholder is a real
   * offer from the other side rather than a label. Absent everywhere else, so Tab keeps moving
   * focus, which is what a keyboard reader expects of it.
   */
  onAcceptHint?: () => void;
  /**
   * What files arriving at the field do, where that means something.
   *
   * Dropped and pasted alike: they are the same arrival, and a phone has no drag at all, so the
   * two share one handler rather than one being the real path and the other a shortcut to it.
   * Only the mirrored terminal band has one, because it is the only field whose other end can
   * hold an image; absent elsewhere, so a drop there does whatever the browser would have done.
   */
  onFiles?: (files: readonly File[]) => void;
  /** The images the composer is holding, shown above the text the way the box holds them. */
  images?: readonly ComposerImage[];
  /** Takes one of them back out, which is deleting its token from the text. */
  onRemoveImage?: (id: number) => void;
  /**
   * The keys this field's far end needs and a touch keyboard does not have.
   *
   * Only the mirrored terminal band: the other two send a message and are done, where this one
   * is driving a TUI, and Escape, Tab, Ctrl and the arrows are most of how one is driven.
   */
  rail?: {
    modifiers: Record<RailModifier, ModifierState>;
    onModifier: (modifier: RailModifier) => void;
    onKey: (key: RailKey) => void;
  };
  /** The command menu the pane is showing, and how to take one of them. */
  commands?: {
    shown: readonly ComposerCommand[];
    onChoose: (name: string) => void;
  };
}

export function composerEditor(m: ComposerModel): ComposerEditor {
  return ( m.windowBand
  ? {
      value: m.windowComposer.draft,
      onChange: (value: string) => m.windowComposer.change(value),
      // Focusable before the first status, because the watch is focus-gated: a field disabled
      // "until a status arrives" could never be focused, so it could never trigger the watch that
      // delivers the status. Only a KNOWN reason disables it.
      disabled: (m.windowComposer.statusKnown && !m.windowComposer.enabled) || m.windowComposer.pending,
      ariaLabel: m.isCodex ? "Codex composer text" : "Claude composer text",
      // Three states, three strings. `enabled` is false BEFORE the first status as well as after
      // a refusal, and the watch is focus-gated, so keying the placeholder on it alone labelled
      // every unfocused window session "Composer unavailable" -- including one whose window was
      // sitting there resolvable, which is what a passive surface like the Bots tab shows all the
      // time. The placeholder now agrees with `disabled` right above it, which already treats an
      // unknown status as usable.
      placeholder: !m.windowComposer.statusKnown || m.windowComposer.enabled
        ? m.isCodex
          ? "Type into Codex's composer…"
          : "Type into Claude's composer…"
        : "Composer unavailable",
      maxLength: 100_000,
      sendOnEnter: false,
      onFocus: m.windowComposer.onFocus,
      onBlur: m.windowComposer.onBlur,
    }
  : m.tmuxBand
  ? {
      // The draft lives in the hook, not in `localDraft`, because it is not local: it is one
      // half of a value the pane holds the other half of, and the hook is what keeps the two
      // agreeing in both directions.
      value: m.tmuxComposer.draft,
      onChange: m.tmuxComposer.change,
      disabled: m.tmuxComposer.pending,
      ariaLabel: "Type into this session's terminal composer",
      // Claude's own suggestion when it is offering one, shown where the terminal shows it and
      // as what it is: a placeholder, which takes no part in the value and is never pushed.
      // Tab accepts it, the same key that accepts it in the pane.
      placeholder: m.tmuxComposer.hint ?? "Type into Claude's terminal\u2026",
      // A coarse guard rather than the sidecar's own limit restated: that one counts BYTES and
      // this counts UTF-16 units, so they are not the same quantity and cannot be. The number
      // is the sidecar's, which is smaller than a turn sent once because this text is retyped
      // whenever a guess about the box misses. Exceeding it is refused there, with a reason.
      maxLength: 16 * 1024,
      sendOnEnter: true,
      // No `onFocus`: the stream behind this field is already current, where the bands either
      // side of it re-read something at the moment somebody is about to act on it.
      onBlur: m.tmuxComposer.onBlur,
      ...(m.tmuxComposer.hint === null
        ? {}
        : { onAcceptHint: () => void m.tmuxComposer.accept() }),
      onFiles: (files) => void m.tmuxComposer.drop(files),
      images: m.tmuxComposer.images,
      onRemoveImage: m.tmuxComposer.remove,
      rail: {
        modifiers: m.tmuxComposer.modifiers,
        onModifier: m.tmuxComposer.toggleModifier,
        onKey: m.tmuxComposer.pressKey,
      },
      commands: {
        shown: m.tmuxComposer.commands,
        onChoose: m.tmuxComposer.chooseCommand,
      },
    }
  : m.inboxBand
  ? {
      value: m.localDraft,
      onChange: m.unavailable ? () => {} : m.setLocalDraft,
      disabled: m.unavailable || m.deliveryPending,
      ariaLabel: "Message this terminal session",
      placeholder: m.unavailable
        ? "Session not reachable"
        : "Send to the terminal m.session\u2026",
      // The window band's limit, not Pi's: this is the same act, typing into a session someone
      // else owns, and the sidecar refuses more than the harness's inbox should carry.
      maxLength: 100_000,
      sendOnEnter: !m.unavailable,
      // The status is re-read here rather than on a timer: focus is the moment someone intends
      // to type, so it is the moment a stale "not running" is worth correcting.
      onFocus: m.cliInput.refresh,
    }
  : m.agentTerminalBand
  ? {
      value: m.localDraft,
      onChange: m.setLocalDraft,
      disabled: m.deliveryPending,
      ariaLabel: "Message through Agent Feed terminal",
      placeholder: "Send through the open terminal…",
      maxLength: 64 * 1024,
      sendOnEnter: true,
    }
  : {
      value: m.localDraft,
      onChange: m.unavailable ? () => {} : m.setLocalDraft,
      disabled: m.unavailable || m.pending,
      ariaLabel: "Message Pi",
      placeholder: m.unavailable
        ? "Composer unavailable"
        : m.running
          ? "Queue the next instruction…"
          : "Message Pi…",
      maxLength: 200_000,
      sendOnEnter: !m.unavailable,
    }
  );
}


export function composerCaption(m: ComposerModel): { caption: string | null; captionIsError: boolean } {
  let caption: string | null = null;
  let captionIsError = false;
  if (m.windowBand) {
    caption = m.windowComposer.error ?? m.windowComposer.notice;
    captionIsError = m.windowComposer.error != null;
  } else if (m.tmuxBand) {
    // This band latches, so a reason here is a pane that WAS being mirrored and now cannot be
    // reached: a dialog open in the pane, a redraw between frames, or a session that exited under
    // the field. The first of those is the one a reader meets -- measured 2026-09-09, a `/model`
    // picker holds `no-composer` for as long as it is open, where a redraw holds it for less than
    // one ~5ms poll -- which is why `tmuxComposerReasonText` sends them to look at the session
    // rather than telling them to wait. Same precedence as the inbox next door: the reason
    // outranks a request's own error, because "that session is gone" explains the failure where a
    // request that had nowhere to go does not.
    //
    // Only when something is wrong. The standing lines that used to sit here -- what the field
    // was for, and that Tab takes the suggestion -- were true of every session all the time, so
    // they said nothing about THIS one and cost a row under the composer to say it.
    caption = m.tmuxComposer.reason
      ? tmuxComposerReasonText(m.tmuxComposer.reason)
      : m.tmuxComposer.error;
    captionIsError = m.tmuxComposer.reason != null || m.tmuxComposer.error != null;
  } else if (m.inboxBand) {
    // The reason outranks a transport error: "this session is not running" explains the failure,
    // where the message from a request that never had anywhere to go does not.
    caption = m.cliInput.reason ? cliInputReasonText(m.cliInput.reason) : m.deliveryError;
    captionIsError = m.cliInput.reason != null || m.deliveryError != null;
  } else if (m.agentTerminalBand) {
    caption = m.deliveryError ?? "Sending through the open Agent Feed terminal.";
    captionIsError = m.deliveryError != null;
  } else if (m.unavailable) {
    caption = "This session's composer is unavailable.";
  } else if (m.error) {
    caption = m.error;
    captionIsError = true;
  } else if (m.queued > 0) {
    caption = `${m.queued} queued${m.state.queue.steer ? `, ${m.state.queue.steer} steering` : ""}`;
  }
  return { caption, captionIsError };
}


export function composerSectionLabel(m: ComposerModel): string {
  return m.tmuxBand
    ? "Terminal session composer, mirrored"
    : m.inboxBand
    ? "Terminal session composer"
    : m.agentTerminalBand
    ? "Agent Feed terminal composer"
    : m.isClaude
    ? "Claude window composer"
    : m.isCodex
      ? "Codex composer"
      : "Agent prompt";
}
