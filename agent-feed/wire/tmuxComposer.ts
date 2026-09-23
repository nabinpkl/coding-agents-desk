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

import type { RailKey, RailModifiers } from "./railKeys.ts";
import type { TmuxQuestionState } from "./tmuxQuestion.ts";

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
 * One entry of the command menu Claude draws under its box when the text starts with `/`.
 *
 * Read off that menu rather than compiled from disk, and the difference is the point: the list a
 * session offers is its own -- built-ins, this project's commands, whatever plugins and skills it
 * loaded -- and a second list assembled here would be a second source of truth that drifts from it
 * the first time somebody adds a plugin.
 */
export interface ComposerCommand {
  /** The name as it goes into the box, leading `/` and all. */
  name: string;
  /**
   * What the menu says it does, rejoined from however many rows it wrapped onto.
   *
   * Claude elides a long one with an ellipsis before it ever reaches the screen, so this is what
   * the pane shows and not what the command's own help would say.
   */
  description: string;
  /** Whether this is the entry Return would run, which is what the arrows move. */
  selected: boolean;
}

/**
 * One paste Claude has collapsed into a handle, as the box is holding it right now.
 *
 * Claude does not put a long paste in its prompt box: measured on a live pane against v2.1.263,
 * a bracketed paste is literal at 800 characters and at three lines and collapsed at 801 and at
 * four, and the text then lives in a table inside that process rather than on the screen. So a
 * reading of the box can say a paste is there and cannot say what is in it.
 *
 * `held` is the difference between a paste the sidecar can still produce and one it never saw.
 * The sidecar remembers what IT pasted, which covers every push the panel made -- so the words
 * survive a reload of the panel, and are what the preview shows. A paste made at the keyboard
 * leaves a handle nothing on this side has the text of, and that is reported rather than guessed.
 */
export interface ComposerPaste {
  /** The handle exactly as it appears in `text`, which is how the panel finds it there. */
  token: string;
  /** The number Claude gave it. */
  id: number;
  /** Its shape when the sidecar is holding the text, null when nobody on this side is. */
  held: { chars: number; lines: number } | null;
}

/**
 * What a session's tmux composer holds, or why it cannot be read.
 *
 * `text` is null exactly when `reason` is set. An empty composer is `""`, which is a different
 * fact from an unreadable one and the panel treats them differently: one is adopted, the other
 * leaves the draft alone.
 */
export interface TmuxComposerState {
  text: string | null;
  /**
   * The suggestion Claude is offering in the box, or null when it offers none.
   *
   * Not part of `text`, and that distinction is the whole reason this field exists: the hint sits
   * in the same box as a prompt and is drawn FAINT, so a reader that stripped the colour would
   * mirror Claude's own suggestion back into the session as though somebody had typed it. It is
   * shown as what it is -- a placeholder, which Tab accepts -- and never pushed.
   *
   * Only ever a whole empty box. Measured on a live pane: typing a prefix of a suggestion does not
   * ghost the rest of it after the cursor, so there is no half-typed row to split.
   */
  hint: string | null;
  reason: TmuxComposerUnavailableReason | null;
  /**
   * True when `text` is what the box holds, character for character.
   *
   * False means it is a HYPOTHESIS, and the panel must not overwrite a draft with it. Two things
   * make it one, and the panel does not need to tell them apart:
   *
   *   The box wrapped. Claude word-wraps its own rows and the space it broke on survives in
   *   neither of them, so tmux shows a wrapped line and a deliberately broken one identically.
   *
   *   The reading did not reach the end. Everything past the cursor is unknowable -- tmux pads
   *   every row to the pane width -- and it is not always the reader's anyway: Claude draws its
   *   own argument hint there once a command name is complete, so a box the reader left holding
   *   `/rename ` reads as `/rename  [name]`. Adopting that would put Claude's annotation in
   *   somebody's field and then type it into their session for real.
   *
   * The panel still SHOWS an inexact reading when it has nothing of its own; what it will not do
   * is take one over words somebody typed.
   */
  exact: boolean;
  /**
   * The command menu the pane is showing, or empty when it is showing none.
   *
   * Only what FITS on that pane's screen. Claude draws the menu into the rows below its box and
   * stops at the bottom of the terminal, so a session in a short pane offers a short list -- and
   * the way to reach the rest is the way it is in the terminal, by typing more of the name.
   *
   * Empty is the ordinary answer: it is a menu, so it is open only while somebody is part-way
   * through a command.
   */
  commands: readonly ComposerCommand[];
  /**
   * The pastes the box is holding as handles, or empty when it holds none.
   *
   * `text` still carries each handle where it sits, because that IS what the box holds and a push
   * that carries it back is what keeps the paste attached. This says which of them the sidecar
   * can produce the words for, which is what the panel needs to offer a preview and to put a
   * message back in the field after a reload.
   */
  pastes: readonly ComposerPaste[];
}

/**
 * The image kinds a composer will take, which is Claude's own list and not ours.
 *
 * Measured in the CLI (2.1.263): a dropped path reaches an image only if it matches
 * `/\.(png|jpe?g|gif|webp)$/i`, and the bytes are then sniffed independently of that name. So the
 * sidecar writes its file with an extension from THIS list, chosen by sniffing the bytes it was
 * given -- a name and a content that disagree end up in somebody's composer as a literal file
 * path, which is the one failure mode worth engineering against.
 */
export const COMPOSER_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type ComposerImageMediaType = (typeof COMPOSER_IMAGE_MEDIA_TYPES)[number];

/**
 * How large an image the panel may hand over, before base64.
 *
 * Generous next to the composer's own text limit because this is one transfer rather than text
 * retyped whenever a guess about the box misses, and a phone screenshot is a couple of megabytes.
 * Claude resizes to the API's own limits itself, so this is about what a browser should be asked
 * to encode and a sidecar to hold, not about what the model will accept.
 *
 * Shared rather than restated on each side: the panel refuses a file this big before spending a
 * second encoding it, and the sidecar refuses one anyway, and those two have to be the same number
 * or the panel is lying about which files it will take.
 */
export const MAXIMUM_COMPOSER_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * `POST /api/sessions/claude/{id}/composer/image` -- one image, into the pane's own composer.
 *
 * Base64 rather than raw bytes because the panel's transport is JSON both ways: in the webview it
 * is a relay of text frames, and a binary body would have to be encoded there anyway.
 *
 * There is no path in this request, in either direction. The panel never names a file and never
 * learns one: it hands over bytes, and the sidecar -- which is the process on the machine the pane
 * is actually on -- writes them somewhere that machine's Claude can read. That is what makes this
 * work for a session on another Mac, where a path the panel chose would name nothing at all.
 */
export interface ComposerImageDrop {
  data: string;
}

/**
 * One message of a session's composer stream.
 *
 * An envelope rather than a bare composer state, because the pane answers two questions at once
 * and the sidecar reads them from one screen: what the prompt box holds, and what the question
 * dialog standing in front of it holds. Asking separately would be two captures of one pane taken
 * at two instants, which is the same mistake as reading the screen and the cursor apart.
 *
 * The same shape `WindowComposerEnvelope` already uses for the Claude Desktop path, for the same
 * reason and deliberately not unified with it: one is an accessibility tree and the other is a
 * screen, and they agree on nothing below this level.
 *
 * Both fields are optional because a message carries only what CHANGED. `question: null` is a
 * statement -- the dialog has gone -- where an absent `question` says nothing at all.
 */
export interface TmuxComposerEnvelope {
  composer?: TmuxComposerState;
  question?: TmuxQuestionState | null;
}

/**
 * One key rail press, on its way to a session's prompt box.
 *
 * The key is NAMED, and the sidecar turns it into bytes with `bytesForRailKey`. A shape carrying
 * the bytes themselves would let any caller write any sequence into somebody's pane, and would put
 * the mapping in whichever surface happened to send it.
 */
export interface ComposerKeyPress {
  key: RailKey;
  /** What the rail is holding, the way a phone keyboard holds shift for one letter. */
  modifiers: RailModifiers;
}
