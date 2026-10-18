/**
 * What a key rail press means to a PTY.
 *
 * A phone keyboard has no Ctrl, no Esc, no Tab and no arrows, which is most of what a terminal is
 * driven by -- so the rail supplies them, and this module says what they are on the wire. Pure, and
 * tested as such: these bytes are the contract with every program on the far end, and getting one
 * wrong shows up as a shell that beeps rather than as anything a type checker would catch.
 *
 * Shared ground rather than the terminal feature that first needed it, because there are now two
 * callers and they are on opposite sides of the wire: the terminal writes these bytes straight
 * into a PTY it holds open, and the composer band names a key over HTTP for a sidecar to write
 * into a tmux pane that has no terminal attached at all. One home, so a key cannot come to mean
 * two things depending on which surface pressed it.
 */

const ESCAPE = "\u001b";
const CSI = `${ESCAPE}[`;

/** A key the rail sends outright. Modifiers are held instead (`RailModifier`). */
export type RailKey = "escape" | "tab" | "up" | "down" | "left" | "right";

/** A key the rail holds until the next press, the way a phone keyboard's shift works. */
export type RailModifier = "ctrl" | "alt" | "shift";

export type RailModifiers = Record<RailModifier, boolean>;

export const NO_MODIFIERS: RailModifiers = { ctrl: false, alt: false, shift: false };

const ARROW_FINAL: Record<"up" | "down" | "left" | "right", string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
};

/**
 * The xterm modifier parameter: 1 plus a bit per held modifier.
 *
 * Sent as `CSI 1 ; <parameter> <final>` for an arrow, which is what readline and tmux both read. A
 * parameter of 1 means "nothing held", and that case is written without the parameter at all,
 * because plenty of programs only match the short form.
 */
export function modifierParameter(held: RailModifiers): number {
  return 1 + (held.shift ? 1 : 0) + (held.alt ? 2 : 0) + (held.ctrl ? 4 : 0);
}

/**
 * The control byte for a character, or null where there is no such thing.
 *
 * `^ 0x40` over the uppercased character is the whole rule: it folds `@A-Z[\]^_` onto 0x00-0x1f,
 * which is where Ctrl-C (0x03) and Ctrl-D (0x04) come from. Space is Ctrl-@ by convention, and `?`
 * is the one the arithmetic does not cover -- Ctrl-? is delete, 0x7f.
 */
export function controlByte(character: string): string | null {
  if (character.length !== 1) return null;
  if (character === " ") return "\u0000";
  if (character === "?") return "\u007f";
  const code = character.toUpperCase().charCodeAt(0) ^ 0x40;
  return code <= 0x1f ? String.fromCharCode(code) : null;
}

/** The bytes for one rail key, with whatever the rail is holding applied. */
export function bytesForRailKey(key: RailKey, held: RailModifiers = NO_MODIFIERS): string {
  if (key === "escape") return ESCAPE;
  // Shift-Tab is its own sequence rather than a modified Tab, which is how terminals have always
  // spelled it and what a shell's completion menu listens for.
  if (key === "tab") return held.shift ? `${CSI}Z` : "\t";
  const final = ARROW_FINAL[key];
  const parameter = modifierParameter(held);
  return parameter === 1 ? `${CSI}${final}` : `${CSI}1;${parameter}${final}`;
}

/**
 * Whatever the terminal's own keyboard produced, with the rail's held modifiers applied.
 *
 * Ctrl turns a character into its control byte; Alt prefixes it with an escape, which is how a
 * terminal has always spelled Meta. Shift does nothing here on purpose -- the phone's keyboard
 * already sent the capital -- and only means something on the keys the rail sends itself.
 *
 * Anything the modifiers cannot be applied to (a paste, an IME commit, a control byte xterm made
 * itself) passes through untouched rather than being mangled into looking modified.
 */
export function applyModifiers(data: string, held: RailModifiers): string {
  if (!held.ctrl && !held.alt) return data;
  const controlled = held.ctrl ? (controlByte(data) ?? data) : data;
  return held.alt ? `${ESCAPE}${controlled}` : controlled;
}
