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
   * True when the composer's text ran onto more than one screen row.
   *
   * Carried because the panel must not trust `text` to the character in that case: tmux shows a
   * wrapped line and a deliberately broken one identically, so a reconstruction can only guess
   * which it was. The panel still shows it; it just stops treating a disagreement as the user's
   * edit being stale.
   */
  wrapped: boolean;
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
