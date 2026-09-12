// Typing into the composer of a Claude session that is running inside a tmux pane.
//
// The third way to type at a session, and the only one that is a MIRROR rather than a delivery.
// `cliInput.ts` puts a finished turn in the harness's inbox; `/api/agent-sessions` commands a
// session the panel owns. This one drives the keyboard of a CLI somebody else is looking at, so
// what travels is not a turn but the text the composer should be holding right now.
//
// Why the panel sends the whole desired text rather than the keystrokes: only the sidecar can see
// what the composer currently holds, and it can read it in the same breath as it writes. A panel
// that computed its own deltas would compute them against an observation that is already old --
// the person at that keyboard types too, and a stale delta types garbage into their session.
//
// Claude-only, like the inbox, and for the same reason: the box this reads is the Claude TUI's.

/** Why a session's tmux composer cannot be mirrored. */
export type TmuxComposerUnavailableReason =
  /** No live process for this session is running inside a tmux pane. */
  | "no-pane"
  /** There is a pane, but tmux would not answer -- not installed, or its server is gone. */
  | "tmux-unavailable"
  /**
   * The pane answered and its screen holds no composer box.
   *
   * A pane running something that is not Claude, a Claude that is mid-turn and has taken the
   * composer away, or a TUI whose box this build does not recognise. Retryable by construction:
   * the next screen usually has one.
   */
  | "no-composer";

/**
 * What a session's tmux composer holds, or why it cannot be read.
 *
 * `text` is null exactly when `reason` is set. An empty composer is `""`, which is a different
 * fact from an unreadable one and the panel treats them differently: one is adopted, the other
 * leaves the draft alone.
 */
export interface TmuxComposerState {
  text: string | null;
  reason: TmuxComposerUnavailableReason | null;
  /**
   * True when the composer's text ran onto more than one screen row.
   *
   * Carried because the panel must not trust `text` to the character in that case: tmux shows a
   * wrapped line and a deliberately broken one identically, so a reconstruction can only guess
   * which it was. The panel still shows it; it just stops treating a disagreement as the user's
   * edit being stale.
   */
  wrapped: boolean;
}
