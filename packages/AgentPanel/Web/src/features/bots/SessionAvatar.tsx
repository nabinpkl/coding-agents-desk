// A session's face, which is a Bot's face one size down.
//
// Its own file rather than a second export beside `BotAvatar`, because the two differ in every
// part except being round: this one has no picture to show, derives its letters from prose rather
// than from a name, and carries the session's activity where the Bot's carries whether it is on
// the canvas.

import type { Bin } from "@agentdesk/agent-feed-wire";
import { sessionInitials } from "@/features/bots/botSurface";
import { BotFace, useBotFaces } from "@/features/bots/avatar/BotFace";

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
 * So the session gets a face of its own, one size under the Bot's: the same containment the card
 * already draws, said in the one place a reader's eye starts. `size-8` against the Bot's `size-11`
 * on a card and `size-12` in the sidebar, which is small enough to read as belonging to the header
 * above it rather than competing with it.
 *
 * **On its own step of its Bot's colour, not on the Bot's.** The Bot's hue is what says whose
 * session this is; the step is what says which one, and without it a Bot with five sessions had
 * five identical discs and only the letters to go on. The ladder and its measurement live in
 * `styles.css`; the step itself comes from `botSessionShades`, ranked over the Bot's durable
 * roster so a session keeps its colour when its neighbours come and go.
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
  rank,
  className = "",
}: {
  title: string;
  activity: Bin;
  /**
   * Whether a Bot hue AND this session's step on that Bot's ladder are both in scope on an
   * ancestor, which is what `bot-session-accent` resolves against.
   *
   * One boolean for the pair because they are one fact: `botSessionStyle` publishes both or
   * neither, for the reason it gives. Not a nicety either way -- a `calc()` over a custom property
   * nothing set is invalid at computed-value time, so the declaration drops and the disc comes
   * back TRANSPARENT with nothing said about it. The neutral disc is the honest answer wherever
   * there is no hue to be a shade of, and it is the same fallback `BotAvatar` takes.
   *
   * Faces need it too: a face with no hue in scope has no colour to take, so an unshaded session
   * keeps its disc whatever the switch says.
   */
  shaded: boolean;
  /**
   * Which face this session wears, as `botSessionFaceRank` builds it from its Bot's rank and its
   * own step.
   *
   * Deliberately NOT the Bot's face: a Bot with five sessions wearing one face five times teaches
   * nothing, where five faces teach which session is which. The shape is the session's own while
   * the shade stays its step on the Bot's ladder, so the two halves of the mark answer different
   * questions. Absent wherever there is no roster to rank against -- the new-session card's
   * session has no transcript yet and no step on any ladder -- and those keep their initials.
   */
  rank?: number;
  className?: string;
}) {
  const faces = useBotFaces();
  if (faces && rank !== undefined && shaded) {
    // The live ring stays, because the face says which session this is and only the ring says
    // whether it is live. Rounded with it, so the ring hugs the head rather than boxing it.
    return (
      <BotFace
        rank={rank}
        className={`size-8 shrink-0 ${activity === "live" ? "rounded-full ring-2 ring-green-500" : ""} ${className}`}
      />
    );
  }
  return (
    <span
      // Decorative: the title it abbreviates is the next element in the row, and the activity it
      // rings is said in words in the meta line under that. A screen reader that read this would
      // hear the session announced three times.
      aria-hidden
      className={`flex size-8 shrink-0 items-center justify-center rounded-full text-(length:--agent-panel-fs-sidebar-chip,11px) font-semibold ${
        shaded
          ? "bot-session-accent text-foreground"
          : "border border-border bg-muted text-muted-foreground"
      } ${activity === "live" ? "ring-2 ring-green-500" : ""} ${className}`}
    >
      {sessionInitials(title)}
    </span>
  );
}
