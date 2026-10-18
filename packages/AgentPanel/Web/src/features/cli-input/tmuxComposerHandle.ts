// What a mirrored composer hands its surface: the controls, the state, the images it
// is holding, and what to say when there is no composer to mirror.
//
// Separate from the hook because this is the contract the session view reads against,
// and the hook is one implementation of keeping it true.

import type {
  ClaudePermissionMode,
  ComposerCommand,
  ComposerPaste,
  RailKey,
  RailModifier,
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

/**
 * The token Claude leaves where it collapsed a long paste, which is a HANDLE and not the words.
 *
 * Measured on a live pane, v2.1.263: a bracketed paste of more than 800 characters, or of more
 * than three lines, is replaced in the box by `[Pasted text #1]` -- `+N lines` on the multi-line
 * kind -- and the text itself moves into a table inside that process. Claude expands it again on
 * submit, and a single backspace deletes the whole thing.
 *
 * It matters here because the panel's own pushes cross that line. A reader writing a long message
 * into the field sends it, Claude collapses it, and the reading that comes back names a handle to
 * words this side can no longer read. See `holdsFreshPaste`.
 */
const PASTED_TOKEN = /\[Pasted text #\d+(?: \+\d+ lines)?\]/g;

/**
 * Whether `reading` names a paste that `draft` does not, which means the words are not in it.
 *
 * The question a reading has to answer before it may fill the field is whether it carries MORE
 * than the draft does, and a pasted-text token carries strictly less: it stands for text that
 * lives only inside Claude. A token the draft already holds is one this panel has been carrying
 * all along and can push back unchanged; a token it does not hold is new, and the only thing it
 * can be standing in for is the text the field is holding right now.
 */
export function holdsFreshPaste(reading: string, draft: string): boolean {
  return [...reading.matchAll(PASTED_TOKEN)].some((match) => !draft.includes(match[0]));
}

/** Every paste handle in `text`, in the order the composer holds them. */
export function composerPasteTokens(text: string): string[] {
  return [...text.matchAll(PASTED_TOKEN)].map((match) => match[0]);
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
  /**
   * Brings the pane up to date, then presses Return in it. True once Return was pressed.
   *
   * `text` sends that instead of the draft, for a command the panel offers as a button; the caller
   * only does that over an empty draft, because the box holds one value and this replaces it.
   */
  submit: (text?: string) => Promise<boolean>;
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
   * The pastes the composer is holding as handles, for the chips above the field.
   *
   * Claude does not put a long paste in its box, it puts `[Pasted text #N]` there and keeps the
   * text inside its own process. Shown as a chip rather than left in the field as that literal
   * string, for the reason the images beside them are: the field holds what the reader can edit,
   * and a handle is not editable text -- one backspace takes the whole paste.
   *
   * `held` is what separates a chip that opens from one that cannot. The sidecar remembers the
   * text of every paste IT made, which covers everything pushed from this field; a paste somebody
   * made at that keyboard leaves a handle nothing on this side has the words of.
   */
  pastes: readonly ComposerPaste[];
  /**
   * The words behind one handle, or null when nobody on this side is holding them.
   *
   * Fetched when a reader opens the chip rather than carried on the stream: a reading goes out on
   * every redraw of the box, and a paste runs to the composer's whole 16 KiB ceiling.
   */
  previewPaste: (token: string) => Promise<string | null>;
  /**
   * Replaces one handle in the field with the words it stands for.
   *
   * What makes a collapsed message recoverable rather than only readable: a reader whose panel
   * reloaded comes back to a field that is empty and a box that is holding their message, and
   * this is how they get it somewhere they can edit it.
   */
  expandPaste: (token: string) => Promise<void>;
  /**
   * Takes one paste back out of the composer, by its handle.
   *
   * The same act as removing an image and by the same route: the handle is deleted from the text
   * and the ordinary push carries it, so there is no second way into somebody's pane.
   */
  removePaste: (token: string) => void;
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
   * The permission mode the pane's footer last named, or null until a reading has found one.
   *
   * Kept across readings that could not see the footer, because those say nothing about the mode.
   */
  permissionMode: ClaudePermissionMode | null;
  /** Puts the session in one mode, by Shift+Tab in its pane until the footer names it. */
  choosePermissionMode: (mode: ClaudePermissionMode) => Promise<void>;
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
      return (
        "This session's terminal is not showing its composer, usually because a dialog is " +
        "open in it. What you have typed is kept here."
      );
  }
}
