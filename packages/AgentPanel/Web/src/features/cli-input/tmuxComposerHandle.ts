// What a mirrored composer hands its surface: the controls, the state, the images it
// is holding, and what to say when there is no composer to mirror.
//
// Separate from the hook because this is the contract the session view reads against,
// and the hook is one implementation of keeping it true.

import type {
  ComposerCommand,
  RailKey,
  RailModifier,
  TmuxComposerState,
  TmuxComposerUnavailableReason,
  TmuxQuestionState,
} from "@agentdesk/agent-feed-wire";
import type { ModifierState } from "@/features/keyboard/modifierLatch";

/**
 * The token Claude leaves in its box where an image went.
 *
 * The composer's text is the only record of what it is holding: the image itself lives in a table
 * inside that process, which nothing here can read. So the tokens are what the panel counts, and
 * the pictures beside them are the ones this browser sent, matched to the numbers Claude gave
 * them.
 */
const IMAGE_TOKEN = /\[Image #(\d+)\]/g;

/** Every image the composer text says it is holding, in the order it holds them. */
export function composerImageIds(text: string): number[] {
  return [...text.matchAll(IMAGE_TOKEN)].map((match) => Number(match[1]));
}

/** One image in the box: the number Claude gave it, and a picture of it when this panel has one. */
export interface ComposerImage {
  id: number;
  /**
   * A preview of the bytes this browser sent, or null for an image it did not send.
   *
   * Null is the ordinary case for a session somebody else has been dropping files into: the box
   * says an image is there and this panel has never seen it. Shown as the token rather than
   * hidden, so the strip and the text never disagree about how many images are in the composer.
   */
  url: string | null;
}

export interface TmuxComposerHandle {
  /**
   * Whether this session is one the panel mirrors, which LATCHES on the first pane it sees.
   *
   * Sticky rather than live, and that is the whole point of it being separate from `reason`. A
   * session that exits loses its pane, and a band chosen on the live answer would swap itself out
   * from under whoever was mid-sentence, taking their draft with it and explaining nothing. This
   * keeps the field where it is and lets `reason` say what happened, which is what the composer
   * beside it already does for a terminal session that stopped running.
   */
  mirrored: boolean;
  /**
   * Whether this session HAS a pane, which latches the same way and is a weaker claim.
   *
   * `mirrored` needs a composer box to have been seen; this needs only a reading that was not
   * `no-pane`. The two differ for as long as the pane is showing something other than a prompt --
   * a question dialog, most of all, which takes the box away for its whole duration. A surface
   * that drives the KEYBOARD of the pane rather than its box wants this one: it is still the
   * session's real terminal while a dialog stands in it, and a reader who opens that session in
   * the panel because it asked them something must not be told it has no terminal.
   */
  paned: boolean;
  /** Why the pane cannot be reached right now, or null while it can. */
  reason: TmuxComposerUnavailableReason | null;
  /**
   * The question dialog standing in the pane right now, or null when there is none.
   *
   * Rides this handle rather than a subscription of its own, because it comes off the same
   * reading: one capture of one screen answers both what the box holds and what is standing in
   * front of it. A second stream to the same endpoint would be a second pipe on the same pane.
   *
   * What it is FOR is the other direction of the question mirror. The panel draws a question from
   * the tool call and commits answers to the pane; without this it never learns what somebody at
   * that keyboard has already ticked, so a reader arriving mid-dialog would see an empty draft
   * over the top of choices that are already made.
   */
  paneQuestion: TmuxQuestionState | null;
  draft: string;
  change: (value: string) => void;
  /**
   * Claude's own suggestion for this empty box, or null when it is offering none.
   *
   * Shown the way the terminal shows it -- faint, in the box, taking no space in the value -- and
   * never pushed. `accept` is what turns it into text.
   */
  hint: string | null;
  /** Brings the pane up to date, then presses Return in it. */
  submit: () => Promise<void>;
  /** Takes Claude up on `hint`, by pressing Tab in the pane the way a reader there would. */
  accept: () => Promise<void>;
  /**
   * Puts images into the composer, in the order they arrived.
   *
   * Files rather than paths: the pane may be on another machine, and only the sidecar answering
   * for it can write somewhere its Claude can read. Anything that is not an image a composer takes
   * is left alone here and refused by the sidecar with a reason.
   */
  drop: (files: readonly Blob[]) => Promise<void>;
  /** What the box is holding pictures of, for the strip above the field. */
  images: readonly ComposerImage[];
  /**
   * Takes one image back out of the composer.
   *
   * Deletes its token from the text, which is the whole of what removing an image means: the
   * picture in the strip is keyed to that token, and Claude drops an entry nothing refers to. The
   * ordinary push carries it, so there is no second way into the pane.
   */
  remove: (id: number) => void;
  /**
   * The key rail's latched modifiers, and the two ways to drive it.
   *
   * Here rather than in the band because the latch is state: a modifier armed by one tap has to
   * still be armed when the next key is pressed, and it is spent by that press.
   */
  modifiers: Record<RailModifier, ModifierState>;
  toggleModifier: (modifier: RailModifier) => void;
  pressKey: (key: RailKey) => void;
  /**
   * The command menu the pane is showing, which is open only while a `/` is being typed.
   *
   * Claude's own list rather than one assembled here, so it carries this session's plugins and
   * project commands and cannot drift from what pressing Return would actually run.
   */
  commands: readonly ComposerCommand[];
  /**
   * Takes one of them, by putting its name in the field the way typing it would.
   *
   * A trailing space, because that is what completes the name: measured on a live pane, it closes
   * the menu and Claude puts its own argument hint in the box instead. Deliberately NOT a second
   * way into the pane -- the ordinary debounced push carries it, so choosing a command and typing
   * one are the same act.
   */
  chooseCommand: (name: string) => void;
  pending: boolean;
  error: string | null;
  /**
   * Flushes an edit still inside the debounce, so leaving the field never leaves the pane behind.
   *
   * There is deliberately no focus half. A polled read had to be refreshed at the moment somebody
   * was about to act on it; a stream is already current.
   */
  onBlur: () => void;
}

/** What each reason means to somebody looking at the field. */
export function tmuxComposerReasonText(reason: TmuxComposerUnavailableReason): string {
  switch (reason) {
    case "no-pane":
      return "This session is not running in a terminal, so there is no composer to mirror.";
    case "tmux-unavailable":
      return "tmux is not answering, so this session's composer cannot be reached.";
    // Named for the absence rather than for a cause, because the sidecar reads a screen with no
    // box on it and cannot tell which of two things put it there. This line used to name only
    // the rarer one, and told the reader to wait for something that was not coming.
    //
    // Measured 2026-09-09. A pane mid-redraw really does lose its box, but that window came and
    // went inside a single ~5ms poll and the watcher's trailing coalesce steps over it. What a
    // reader actually meets is a DIALOG -- `/model`, `/resume`, a permission prompt -- which
    // replaces the box with an option list and stands until somebody answers it in the pane:
    // `/model` held this state for the full fourteen seconds its picker was open.
    //
    // So the line says where to look instead of promising a return, and says the draft is safe,
    // because it is: a push that lands on this reason sends nothing and `submit` refuses to send
    // after it, so the text stays in the field and the next push or send puts it in the box.
    case "no-composer":
      return "This session's terminal is not showing its composer, usually because a dialog is "
        + "open in it. What you have typed is kept here.";
  }
}
