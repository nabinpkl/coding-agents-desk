// What a `[Pasted text #N]` handle in somebody's composer stands for.
//
// Claude Code does not put a long paste in its prompt box. It puts a HANDLE there and keeps the
// text in a table inside its own process: measured on a live pane against v2.1.263, a bracketed
// paste is literal at 800 characters and at three lines, and collapsed at 801 and at four. The
// handle behaves as one character -- a single backspace deletes the whole thing -- and Claude
// expands it again when the turn is submitted.
//
// That is correct behaviour for a person pasting at a keyboard, and it takes two things away from
// a MIRROR of that box, which is what this module gives back.
//
//   Typing stops being cheap. The panel pushes the whole draft, so once it collapses, the screen
//   reads `[Pasted text #1]` and the draft reads nine hundred characters, which share no prefix.
//   Every keystroke then falls to the correction path: one backspace to eat the handle and a
//   re-paste of the entire message. Measured before this existed -- three keystrokes against a
//   900-character draft produced three fresh handles, `#25 #26 #27`, one whole re-paste each.
//
//   The words stop being recoverable. A panel that reloads, or a phone whose webview was
//   discarded, comes back with an empty field looking at a box that holds a handle, and nothing
//   anywhere can say what it stands for.
//
// Both close the same way: the side that DID the pasting remembers what it pasted. So this binds
// the handle Claude answered with to the text that produced it, and `meaning` reads a screen
// through those bindings -- which is what lets the diff see a prefix again, and what lets the
// panel offer the words back.
//
// Only pastes the panel itself made are ever bound. A paste somebody made at the keyboard leaves
// a handle this side never saw the text of, and it stays unknown rather than guessed at.

/**
 * A paste handle as Claude writes it, which is the image token's sibling in `composerBox`.
 *
 * `ATTACHMENT` there matches both kinds, because what it is for is counting backspaces and both
 * kinds cost one press. This one is narrower on purpose: an image's token is the canonical text
 * of what the box holds and expanding it would be wrong, where a paste's token is a stand-in for
 * text that exists somewhere else.
 */
const PASTE = /\[Pasted text #(\d+)(?: \+\d+ lines)?\]/g;

/** Every paste handle in `text`, in the order the box holds them. */
export function pasteTokens(text: string): { token: string; id: number }[] {
  return [...text.matchAll(PASTE)].map((match) => ({ token: match[0], id: Number(match[1]) }));
}

/** What the sidecar is holding for one handle, which is how the panel decides what to offer. */
export interface HeldPaste {
  chars: number;
  lines: number;
}

/**
 * The handles a pane is holding text for, bound as they are created and read back by meaning.
 *
 * Keyed by PANE rather than by session, because the numbering belongs to the CLI process running
 * in it: two sessions both have a `#1` and they are different text.
 */
export interface ComposerPasteStore {
  /** Remembers that `token` in `pane` stands for `text`. */
  bind(pane: string, token: string, text: string): void;
  /** The text `token` stands for, or null when this side did not paste it. */
  textFor(pane: string, token: string): string | null;
  /** Its shape without its content, which is what a reading carries. */
  heldFor(pane: string, token: string): HeldPaste | null;
  /** Drops everything remembered for a pane, for a session that ended. */
  forget(pane: string): void;
}

/**
 * How much pasted text the process will hold, and how many handles.
 *
 * A budget rather than a lifetime, because there is no event that says a handle is finished with:
 * a submitted turn takes its handles with it, and nothing tells this side that it happened. So
 * the oldest binding is dropped when a new one does not fit, which costs exactly what not
 * remembering cost before -- a re-paste, and a preview the panel cannot offer.
 *
 * Four megabytes is a couple of hundred pushes at the composer's own 16 KiB ceiling, which is far
 * more than a reader gets through before a reload, and small enough that a sidecar running for a
 * week is not holding anybody's afternoon in memory.
 */
const BUDGET_BYTES = 4 * 1024 * 1024;
const BUDGET_ENTRIES = 512;

/**
 * One store for the process, insertion-ordered so the oldest binding is the first to go.
 *
 * A single flat map rather than one per pane, because the budget is the process's: a per-pane
 * allowance would either be too small for the pane somebody is actually working in or large
 * enough, times fifty panes, to be no budget at all.
 */
export function composerPastes(): ComposerPasteStore {
  const held = new Map<string, string>();
  let bytes = 0;

  const at = (pane: string, token: string): string => `${pane}\u0000${token}`;

  const drop = (key: string): void => {
    const text = held.get(key);
    if (text === undefined) return;
    bytes -= text.length;
    held.delete(key);
  };

  return {
    bind(pane, token, text) {
      const key = at(pane, token);
      // Re-binding the same handle replaces it rather than counting twice. Claude reuses a number
      // only after a restart, but a push that lands twice is ordinary.
      drop(key);
      held.set(key, text);
      bytes += text.length;
      while ((bytes > BUDGET_BYTES || held.size > BUDGET_ENTRIES) && held.size > 1) {
        const oldest = held.keys().next();
        if (oldest.done) break;
        drop(oldest.value);
      }
    },
    textFor(pane, token) {
      return held.get(at(pane, token)) ?? null;
    },
    heldFor(pane, token) {
      const text = held.get(at(pane, token));
      if (text === undefined) return null;
      return { chars: [...text].length, lines: text.split("\n").length };
    },
    forget(pane) {
      const prefix = `${pane}\u0000`;
      for (const key of [...held.keys()]) {
        if (key.startsWith(prefix)) drop(key);
      }
    },
  };
}

/**
 * What a composer reading MEANS, which is the screen with every known handle expanded.
 *
 * The diff runs on this rather than on the screen text, and that is the whole point: a box
 * reading `[Pasted text #1]` and a draft reading nine hundred characters share no prefix, so
 * every keystroke fell to a full re-paste. Through their meaning they share all but the last
 * character, and a keystroke costs a keystroke again.
 *
 * Applied to BOTH sides. The panel may carry either form -- the words, for a message it is
 * holding, or the handle, for one it adopted from the pane -- and expanding both is what makes
 * those the same request instead of two.
 *
 * A handle this side did not paste is left exactly as it is. It is not a failure to expand: the
 * token IS what the box holds, and leaving it means a push that carries it pushes it back
 * unchanged rather than retyping the characters of its name, which would detach the paste in
 * somebody's session and lose what they pasted.
 */
export function meaning(
  text: string,
  lookup: (token: string) => string | null,
): string {
  return text.replace(PASTE, (token) => lookup(token) ?? token);
}
