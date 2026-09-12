// A session's face, which is a Bot's face one size down.
//
// Its own file rather than a second export beside `BotAvatar`, because the two differ in every
// part except being round: this one has no picture to show, derives its letters from prose rather
// than from a name, and carries the session's activity where the Bot's carries whether it is on
// the canvas.

import type { Bin } from "@agentdesk/agent-feed-wire";
import { sessionInitials } from "@/features/bots/botSurface";

/**
 * The mark that says a session belongs to the Bot it sits in, and which of that Bot's sessions
 * it is.
 *
 * A session row used to open with a 8px dot that meant live or not live, and the title beside it
 * had nothing of its own holding the leading edge. Two things followed. The row's anchor was a
 * dot that said nothing about WHICH session this was, so a roster read as a column of identical
 * dots with different prose after them. And the provider badge on the trailing edge -- filled,
 * uppercase, monospaced -- was the only shaped thing in the row, so the eye went to the label
 * about the session before the session.
 *
 * So the session gets a face of its own, in its Bot's colour, one size under the Bot's: the same
 * containment the card already draws, said in the one place a reader's eye starts. `size-6`
 * against the Bot's `size-9` on a card and `size-10` in the sidebar, which is small enough to
 * read as belonging to the header above it rather than competing with it.
 *
 * **Activity is a ring rather than a corner badge.** A badge would have to be ringed in whatever
 * is behind it to read as sitting ON the disc, and what is behind it here changes: a session's
 * titlebar is `session-view-header` when the card is open and the card's own shade when it is
 * closed. A ring needs no such agreement. Cold is left unmarked rather than given a grey ring,
 * because the meta line under the title already says "Cold" in words and a second grey thing
 * next to it would be the row's third neutral shape.
 */
export function SessionAvatar({
  title,
  activity,
  shaded,
  className = "",
}: {
  title: string;
  activity: Bin;
  /**
   * Whether a Bot hue is in scope on an ancestor, which is what `bot-accent` resolves against.
   *
   * Not a nicety: `oklch(l c var(--bot-hue))` with no `--bot-hue` set is invalid at computed-value
   * time, so the declaration drops and the disc comes back TRANSPARENT with nothing said about it.
   * The neutral disc is the honest answer wherever there is no hue -- an unranked Bot, the session
   * picker's preview -- and it is the same fallback `BotAvatar` takes for the same reason.
   */
  shaded: boolean;
  className?: string;
}) {
  return (
    <span
      // Decorative: the title it abbreviates is the next element in the row, and the activity it
      // rings is said in words in the meta line under that. A screen reader that read this would
      // hear the session announced three times.
      aria-hidden
      className={`flex size-6 shrink-0 items-center justify-center rounded-full text-(length:--agent-panel-fs-sidebar-chip,11px) font-semibold ${
        shaded ? "bot-accent text-foreground" : "border border-border bg-muted text-muted-foreground"
      } ${activity === "live" ? "ring-2 ring-green-500" : ""} ${className}`}
    >
      {sessionInitials(title)}
    </span>
  );
}
