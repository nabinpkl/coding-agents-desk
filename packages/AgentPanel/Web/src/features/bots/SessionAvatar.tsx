// A session's face, which is a Bot's face one size down.
//
// Its own file rather than a second export beside `BotAvatar`, because the two differ in every
// part except being round: this one has no picture to show, derives its letters from prose rather
// than from a name, and carries the session's activity where the Bot's carries whether it is on
// the canvas.

import type { Bin } from "@agentdesk/agent-feed-wire";
import { sessionInitials } from "@/features/bots/botSurface";
import { BotFace } from "@/features/bots/avatar/BotFace";
import { useBotFaces } from "@/features/bots/avatar/botFacesSwitch";

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
 * `styles.css`; the step itself comes from `botSessionSlots`, stored per session so a reorder,
 * a detach and a return all leave it where it was.
 *
 * **Activity is a ring rather than a corner badge.** A badge would have to be ringed in whatever
 * is behind it to read as sitting ON the disc, and what is behind it here changes: a session's
 * titlebar is `session-view-header` when the card is open and the card's own shade when it is
 * closed. A ring needs no such agreement. Cold takes no grey ring, because a grey ring would be the
 * row's third neutral shape. It is said instead by the sleeping Zs of a cartoon, a big one at the
 * top corner of the head and two smaller ones drifting up and away, mostly off the disc so they
 * need no ring either.
 *
 * **The face carries all of it, wherever it is drawn.** Live is the ring, cold the Zs, anything
 * else neither, on the card, in the roster, in the Sessions view and in the modal's header alike.
 * The Zs were once something a caller asked for, and only the card did: the Sessions view took the
 * face later, copied the roster's call, and drew a cold session as awake. One session reads as one
 * session everywhere, so there is nothing here for a caller to opt into.
 */
export function SessionAvatar({
  title,
  activity,
  shaded,
  rank,
  shut = false,
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
  /**
   * Whether this session's card is folded, which the face answers by closing its eyes.
   *
   * The roster had no way to say this at all. An open row used to take `bg-muted`, a utility that
   * outranks the colour layer, so the one row a reader was most likely looking at was the one that
   * lost its colour -- and folded state is not worth a colour it has to take from identity. Eyes
   * are free: nothing else was using them. The initials fallback ignores it, because letters have
   * no eyes to close and a second treatment for one fact is a second thing to learn.
   */
  shut?: boolean;
  className?: string;
}) {
  const faces = useBotFaces();
  const asleep = activity === "cold";
  const mark = sessionMark({ faces, title, activity, shaded, rank, shut, className: asleep ? "" : className });
  if (!asleep) return mark;
  return (
    <span className={`relative shrink-0 ${className}`}>
      {mark}
      <SleepingZs className="pointer-events-none absolute -top-2.5 -right-3 size-[18px] session-muted-ink" />
    </span>
  );
}

/**
 * Three Zs, big to small, rising up and to the right from where they leave the head.
 *
 * Strokes in `currentColor` rather than letters, so they keep their shape at any font and stay
 * crisp at this size. Round caps and joins, the way a face's own lines are drawn.
 */
function SleepingZs({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 18 18" aria-hidden data-sleeping className={className}>
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="1.5,10.5 7.5,10.5 1.5,16.5 7.5,16.5" strokeWidth="1.75" />
        <polyline points="9,5.5 12.5,5.5 9,9 12.5,9" strokeWidth="1.5" />
        <polyline points="13.75,1.5 16.25,1.5 13.75,4 16.25,4" strokeWidth="1.25" />
      </g>
    </svg>
  );
}

function sessionMark({
  faces,
  title,
  activity,
  shaded,
  rank,
  shut,
  className,
}: {
  title: string;
  activity: Bin;
  shaded: boolean;
  rank: number | undefined;
  shut: boolean;
  className: string;
} & { faces: boolean }) {
  if (faces && rank !== undefined && shaded) {
    // The live ring stays, because the face says which session this is and only the ring says
    // whether it is live. Rounded with it, so the ring hugs the head rather than boxing it.
    return (
      <BotFace
        rank={rank}
        shut={shut}
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
        shaded ? "bot-session-accent text-foreground" : "border border-border bg-muted text-muted-foreground"
      } ${activity === "live" ? "ring-2 ring-green-500" : ""} ${className}`}
    >
      {sessionInitials(title)}
    </span>
  );
}
