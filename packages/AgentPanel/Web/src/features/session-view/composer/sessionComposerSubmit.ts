// Sending: the two submit paths, and the context meter's Compact button, which rides them.
//
// The two paths are separate on purpose: one joins the panel's own queue and can be steered, the
// other hands a whole turn to a transport the panel does not own.

import type { ComposerModel } from "@/features/session-view/composer/sessionComposerModel";
import { parseOpencodeCommand } from "@/features/session-view/composer/useOpencodeCommands";
import type { CompactControl } from "@/features/activity-feed/TokenMeter";

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
