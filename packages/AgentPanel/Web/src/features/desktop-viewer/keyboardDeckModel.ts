/**
 * The iPhone keyboard's layout and typing behaviour, ported from the Swift keyboard extension in
 * `client/AgentDeskKeyboard/` (`KeyboardLayout.swift` and `AgentDeskQWERTYView.swift`).
 *
 * The panel draws this deck instead of focusing a field and borrowing WebKit's keyboard, because a
 * focused editable in a browser tab always gets WebKit's form-navigation strip drawn over the
 * panel's own controls and no web API removes it. A deck made of buttons focuses nothing, so the
 * strip never exists.
 *
 * Two things from the Swift do not cross and are gone rather than stubbed. Automatic
 * capitalisation read the host field's `autocapitalizationType` and `documentContextBeforeInput`;
 * the Mac sends neither, and guessing from local echo would be a guess dressed as a mirror. The
 * globe key switched iOS input modes, which a page has none of.
 */

export type KeyboardPage = "alphabet" | "numbers" | "symbols";
export type KeyboardShift = "off" | "on" | "locked";

export type DeckKey =
  | { kind: "character"; value: string }
  | { kind: "shift" }
  | { kind: "delete" }
  | { kind: "page"; page: KeyboardPage }
  | { kind: "space" }
  | { kind: "return" }
  /**
   * Hand typing back to the browser's own keyboard.
   *
   * This is the globe key's seat, and close to its job: iOS put it between the page key and the
   * space bar to switch input modes, and a page has exactly two -- this deck, or the system
   * keyboard the deck was built to avoid. Keeping the way back visible is what makes the deck
   * safe to default to.
   */
  | { kind: "native" };

export interface KeyboardDeckState {
  page: KeyboardPage;
  shift: KeyboardShift;
}

export const INITIAL_DECK_STATE: KeyboardDeckState = { page: "alphabet", shift: "off" };

/** Measured on `systemUptime` in `KeyboardViewController.handleKey`; the same window here. */
export const SHIFT_DOUBLE_TAP_MS = 350;
export const DELETE_REPEAT_DELAY_MS = 450;
export const DELETE_REPEAT_INTERVAL_MS = 80;
/** Horizontal travel over the space bar that moves the remote caret one character. */
export const SPACE_CURSOR_STEP_PX = 14;
/**
 * How far the finger must travel before the space bar becomes a caret pad rather than a key.
 *
 * iOS gets this free from `UIPanGestureRecognizer`, which spends its slop before `.began` fires
 * and only then starts measuring. Without an equivalent, a space bar tapped with a little drift
 * would move the caret instead of typing a space.
 */
export const SPACE_PAN_SLOP_PX = 10;

function characters(source: readonly string[] | string): DeckKey[] {
  return [...source].map((value) => ({ kind: "character", value }) as DeckKey);
}

const PUNCTUATION_ROW = [".", ",", "?", "!", "'"];

function bottomRow(page: KeyboardPage): DeckKey[] {
  return [{ kind: "page", page }, { kind: "native" }, { kind: "space" }, { kind: "return" }];
}
const alphabetBottomRow = bottomRow("numbers");
const SYMBOL_BOTTOM_ROW = bottomRow("alphabet");

export function deckRows(state: KeyboardDeckState): DeckKey[][] {
  switch (state.page) {
    case "alphabet":
      return [
        characters("qwertyuiop"),
        characters("asdfghjkl"),
        [{ kind: "shift" }, ...characters("zxcvbnm"), { kind: "delete" }],
        alphabetBottomRow,
      ];
    case "numbers":
      return [
        characters("1234567890"),
        characters(["-", "/", ":", ";", "(", ")", "$", "&", "@", "\""]),
        [
          { kind: "page", page: "symbols" },
          ...characters(PUNCTUATION_ROW),
          { kind: "delete" },
        ],
        SYMBOL_BOTTOM_ROW,
      ];
    case "symbols":
      return [
        characters(["[", "]", "{", "}", "#", "%", "^", "*", "+", "="]),
        characters(["_", "\\", "|", "~", "<", ">", "€", "£", "¥", "•"]),
        [
          { kind: "page", page: "numbers" },
          ...characters(PUNCTUATION_ROW),
          { kind: "delete" },
        ],
        SYMBOL_BOTTOM_ROW,
      ];
  }
}

/** Stable per key within a page, so React reconciliation and tests can both name one. */
export function deckKeyId(key: DeckKey): string {
  switch (key.kind) {
    case "character":
      return `char-${[...key.value].map((unit) => unit.codePointAt(0)!.toString(16)).join("-")}`;
    case "page":
      return `page-${key.page}`;
    default:
      return key.kind;
  }
}

export function deckKeyLabel(key: DeckKey, state: KeyboardDeckState): string {
  switch (key.kind) {
    case "character":
      return state.page === "alphabet" && state.shift !== "off"
        ? key.value.toUpperCase()
        : key.value;
    case "shift":
      return state.shift === "locked" ? "⇪" : "⇧";
    case "delete":
      return "⌫";
    case "page":
      return key.page === "alphabet" ? "ABC" : key.page === "numbers" ? "123" : "#+=";
    case "space":
      return "";
    case "return":
      // Always the plain return glyph. iOS varies it (Go, Search, Send, Done) from the focused
      // field's `returnKeyType`, which the Mac does not report.
      return "↵";
    case "native":
      // Drawn as an icon rather than a glyph: U+2328 exists in the system font but renders far
      // smaller than the other keycap glyphs, which made the key hard to read.
      return "";
  }
}

export function deckKeyName(key: DeckKey): string {
  switch (key.kind) {
    case "character":
      return key.value;
    case "shift":
      return "Shift";
    case "delete":
      return "Delete";
    case "page":
      return key.page === "alphabet" ? "Letters" : key.page === "numbers" ? "Numbers" : "Symbols";
    case "space":
      return "Space";
    case "return":
      return "Return";
    case "native":
      return "Switch to the system keyboard";
  }
}

/**
 * Ratios against the first key of the row, from the Swift width constraints.
 *
 * The bottom row is the one place they are not copied. The Swift gives the page key 1.35 against
 * the globe's 1.05, which draws `123` about forty percent wider than an iPhone's and takes the
 * width out of the space bar; on iOS the page key and the mode switch beside it are the same size.
 * So the page key matches its neighbour here, and the space bar keeps what that returns.
 */
export function keyWidthWeight(key: DeckKey): number {
  switch (key.kind) {
    case "space":
      return 3.8;
    case "return":
      return 1.65;
    case "page":
    case "native":
      return 1.05;
    case "shift":
    case "delete":
      return 1.25;
    case "character":
      return 0.88;
  }
}

/** Special keys carry the darker fill; only characters and the space bar are "regular". */
export function isSpecialKey(key: DeckKey): boolean {
  return key.kind !== "character" && key.kind !== "space";
}

export interface DeckKeyResult {
  state: KeyboardDeckState;
  /** The text this press types, or null for a press that only changed the layout. */
  output: string | null;
}

export function handleDeckKey(state: KeyboardDeckState, key: DeckKey): DeckKeyResult {
  switch (key.kind) {
    case "character": {
      const shifted = state.page === "alphabet" && state.shift !== "off";
      return {
        state: state.shift === "on" ? { ...state, shift: "off" } : state,
        output: shifted ? key.value.toUpperCase() : key.value,
      };
    }
    case "page":
      return {
        state: { page: key.page, shift: key.page === "alphabet" ? state.shift : "off" },
        output: null,
      };
    case "space":
      return { state: state.shift === "on" ? { ...state, shift: "off" } : state, output: " " };
    case "return":
      return { state: state.shift === "on" ? { ...state, shift: "off" } : state, output: "\n" };
    // Delete leaves an armed shift armed, which is what the Swift does by returning nil without
    // touching the state: backspacing mid-word must not lose the capital you were about to type.
    // Shift and the keyboard switch are handled by their pressers, not here.
    case "delete":
    case "shift":
    case "native":
      return { state, output: null };
  }
}

export function handleShiftTap(
  state: KeyboardDeckState,
  isDoubleTap: boolean,
): KeyboardDeckState {
  switch (state.shift) {
    case "off":
      return { ...state, shift: "on" };
    case "on":
      return { ...state, shift: isDoubleTap ? "locked" : "off" };
    case "locked":
      return { ...state, shift: "off" };
  }
}

// One definition, in `features/keyboard`: the terminal's key rail asks the same question, and a
// second copy of this media query is exactly the kind of thing that drifts by one clause.
export { drawsOwnKeyboard } from "../keyboard/softwareKeyboard";
