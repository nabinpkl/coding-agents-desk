import type {
  DesktopCursorKind,
  DesktopTextFocusEvent,
  RemoteKeyCode,
  RemoteKeyEvent,
  RemoteModifier,
} from "@agentdesk/agent-feed-wire";

export const KEYBOARD_FOCUS_TIMEOUT_MS = 700;
export const MAX_PENDING_KEY_EVENTS = 32;
export const MAX_RECEIPT_EVENTS = 64;
export const KEYBOARD_VIEWPORT_SHRINK_PX = 80;
export const KEYBOARD_VIEWPORT_RESTORE_TOLERANCE_PX = 24;
export const REMOTE_MODIFIER_ORDER: RemoteModifier[] = ["cmd", "ctrl", "option", "shift"];

export type KeyboardPresentation = "unavailable" | "hidden" | "pending" | "shown";
export type ModifierState = "off" | "armed" | "locked";

export interface KeyboardPresentationState {
  presentation: KeyboardPresentation;
  focusRequestId: string | null;
  secure: boolean;
  editability: DesktopTextFocusEvent["editability"] | null;
}

export type KeyboardPresentationAction =
  | { type: "transport-open" }
  | { type: "transport-close" }
  | { type: "remote-tap"; focusRequestId: string }
  | { type: "manual-show"; focusRequestId: string }
  | { type: "focus-result"; event: DesktopTextFocusEvent }
  | { type: "focus-timeout"; focusRequestId: string }
  | { type: "hide" };

export const INITIAL_KEYBOARD_PRESENTATION: KeyboardPresentationState = {
  presentation: "unavailable",
  focusRequestId: null,
  secure: false,
  editability: null,
};

/**
 * Whether a tap under this remote cursor shape is worth summoning the keyboard for.
 *
 * WebKit only raises the software keyboard from a focus inside the tap's own gesture, and whether
 * the tap landed on a text field is only knowable from the Mac, one round trip too late. So the
 * page has to guess before it asks, and the cursor shape is the guess: macOS is already drawing an
 * I-beam over the target, the mirror streams that shape on the same channel, and in relative
 * pointer mode a tap does not move the cursor, so the shape settled long before the finger landed.
 *
 * `unknown` primes. A cursor the classifier could not name, or a stream that has not sent its first
 * shape yet, must not be the reason a text field refuses to open its keyboard; a wrong prime costs
 * a keyboard flash, a wrong refusal costs the feature.
 *
 * The Mac already trusts this shape for the same question at the other end: its probe coordinator
 * refuses to sample Accessibility at all unless the cursor is an I-beam
 * (`HostTextInputFocusProbeCoordinator`). This gate asks it one round trip earlier, where the answer
 * is still in time to decide whether to raise a keyboard rather than to withdraw one.
 */
export function shouldPrimeKeyboard(cursorKind: DesktopCursorKind): boolean {
  return cursorKind === "ibeam" || cursorKind === "unknown";
}

export function keyboardPresentationReducer(
  state: KeyboardPresentationState,
  action: KeyboardPresentationAction,
): KeyboardPresentationState {
  switch (action.type) {
    case "transport-open":
      return state.presentation === "unavailable"
        ? { ...state, presentation: "hidden" }
        : state;
    case "transport-close":
      return INITIAL_KEYBOARD_PRESENTATION;
    case "remote-tap":
      return state.presentation === "unavailable" ? state : {
        presentation: "pending",
        focusRequestId: action.focusRequestId,
        secure: false,
        editability: null,
      };
    case "manual-show":
      return state.presentation === "unavailable" ? state : {
        presentation: "shown",
        focusRequestId: action.focusRequestId,
        secure: false,
        editability: null,
      };
    case "focus-result": {
      if (state.focusRequestId !== action.event.focusRequestId) return state;
      if (state.presentation === "shown") {
        return {
          ...state,
          secure: action.event.secure,
          editability: action.event.editability,
        };
      }
      if (state.presentation !== "pending") return state;
      const editable = action.event.editability === "editable"
        || (action.event.editability === "ambiguous" && action.event.cursorKind === "ibeam");
      return editable
        ? {
            presentation: "shown",
            focusRequestId: action.event.focusRequestId,
            secure: action.event.secure,
            editability: action.event.editability,
          }
        : {
            presentation: "hidden",
            focusRequestId: null,
            secure: false,
            editability: action.event.editability,
          };
    }
    case "focus-timeout":
      return state.presentation === "pending" && state.focusRequestId === action.focusRequestId
        ? { presentation: "hidden", focusRequestId: null, secure: false, editability: null }
        : state;
    case "hide":
      return state.presentation === "unavailable" ? state : {
        presentation: "hidden",
        focusRequestId: null,
        secure: false,
        editability: null,
      };
  }
}

export function cycleModifier(state: ModifierState): ModifierState {
  return state === "off" ? "armed" : state === "armed" ? "locked" : "off";
}

export function activeModifiers(
  states: Record<RemoteModifier, ModifierState>,
  intrinsic: RemoteModifier[] = [],
): RemoteModifier[] {
  const active = new Set(intrinsic);
  for (const modifier of REMOTE_MODIFIER_ORDER) {
    if (states[modifier] !== "off") active.add(modifier);
  }
  return REMOTE_MODIFIER_ORDER.filter((modifier) => active.has(modifier));
}

export function clearArmedModifiers(
  states: Record<RemoteModifier, ModifierState>,
): Record<RemoteModifier, ModifierState> {
  return Object.fromEntries(REMOTE_MODIFIER_ORDER.map((modifier) => [
    modifier,
    states[modifier] === "armed" ? "off" : states[modifier],
  ])) as Record<RemoteModifier, ModifierState>;
}

const UNSHIFTED_PUNCTUATION: Record<string, RemoteKeyCode> = {
  ",": "ansi-comma", ".": "ansi-period", "/": "ansi-slash", ";": "ansi-semicolon",
  "'": "ansi-quote", "[": "ansi-leftbracket", "]": "ansi-rightbracket",
  "\\": "ansi-backslash", "-": "ansi-minus", "=": "ansi-equal", "`": "ansi-grave",
};
const SHIFTED_PUNCTUATION: Record<string, RemoteKeyCode> = {
  "<": "ansi-comma", ">": "ansi-period", "?": "ansi-slash", ":": "ansi-semicolon",
  "\"": "ansi-quote", "{": "ansi-leftbracket", "}": "ansi-rightbracket",
  "|": "ansi-backslash", "_": "ansi-minus", "+": "ansi-equal", "~": "ansi-grave",
};
const SHIFTED_DIGITS = "!@#$%^&*()";

export function remoteKeyForCharacter(character: string): RemoteKeyEvent | null {
  if ([...character].length !== 1) return null;
  if (character === "\n" || character === "\r") return { code: "return", modifiers: [] };
  if (character === " ") return { code: "space", modifiers: [] };
  if (/^[a-z]$/.test(character)) {
    return { code: `ansi-${character.toUpperCase()}` as RemoteKeyCode, modifiers: [] };
  }
  if (/^[A-Z]$/.test(character)) {
    return { code: `ansi-${character}` as RemoteKeyCode, modifiers: ["shift"] };
  }
  if (/^[0-9]$/.test(character)) {
    return { code: `ansi-${character}` as RemoteKeyCode, modifiers: [] };
  }
  const shiftedDigit = SHIFTED_DIGITS.indexOf(character);
  if (shiftedDigit >= 0) {
    const digit = shiftedDigit === 9 ? "0" : String(shiftedDigit + 1);
    return { code: `ansi-${digit}` as RemoteKeyCode, modifiers: ["shift"] };
  }
  const unshifted = UNSHIFTED_PUNCTUATION[character];
  if (unshifted) return { code: unshifted, modifiers: [] };
  const shifted = SHIFTED_PUNCTUATION[character];
  return shifted ? { code: shifted, modifiers: ["shift"] } : null;
}

/** Converts the whole insertion or rejects it, so paste and composition never partially send. */
export function remoteKeysForText(text: string): RemoteKeyEvent[] | null {
  const events: RemoteKeyEvent[] = [];
  for (const character of text) {
    const event = remoteKeyForCharacter(character);
    if (!event) return null;
    events.push(event);
  }
  return events;
}

const CONTROL_RECEIPT: Partial<Record<RemoteKeyCode, string>> = {
  escape: "Esc", tab: "⇥", return: "↵", delete: "⌫",
  left: "←", right: "→", up: "↑", down: "↓",
};

export function receiptToken(event: RemoteKeyEvent, secure: boolean): string {
  const control = CONTROL_RECEIPT[event.code];
  if (control) return control;
  if (secure) return "•";
  if (event.code === "space") return " ";
  const shifted = event.modifiers.includes("shift");
  if (/^ansi-[A-Z]$/.test(event.code)) {
    const letter = event.code.slice(5);
    return shifted ? letter : letter.toLowerCase();
  }
  if (/^ansi-[0-9]$/.test(event.code)) {
    const digit = Number(event.code.slice(5));
    return shifted ? SHIFTED_DIGITS[digit === 0 ? 9 : digit - 1]! : String(digit);
  }
  const table = shifted ? SHIFTED_PUNCTUATION : UNSHIFTED_PUNCTUATION;
  return Object.entries(table).find(([, code]) => code === event.code)?.[0] ?? "?";
}

/** Local typing feedback, not a mirror of the Mac's text, caret, or selection. */
export function appendLocalEcho(current: string[], keys: RemoteKeyEvent[], secure: boolean): string[] {
  let echo = [...current];
  for (const key of keys) {
    if (key.code === "return") echo = [];
    else if (key.code === "delete") {
      echo = key.modifiers.includes("cmd") ? [] : echo.slice(0, -1);
    } else if (!CONTROL_RECEIPT[key.code]
        && !key.modifiers.some((modifier) => modifier !== "shift")) {
      echo.push(receiptToken(key, secure));
    }
  }
  return echo.slice(-MAX_RECEIPT_EVENTS);
}
