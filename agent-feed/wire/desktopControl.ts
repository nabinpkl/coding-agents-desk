import type { DesktopCursorKind, WebrtcCursorEvent } from "./desktop.ts";
import type { DesktopNavigationEvent, DesktopNavigationInput } from "./desktopNavigation.ts";

export const DESKTOP_CONTROL_MAX_MESSAGE_BYTES = 16 * 1024;
export const DESKTOP_CONTROL_MAX_KEY_BATCH = 256;
/**
 * How much text one `text` command may carry, in UTF-16 units.
 *
 * Generous enough for a pasted paragraph and bounded well inside the message cap, since the text
 * is JSON-escaped on the way and a single emoji can cost a dozen bytes.
 */
export const DESKTOP_CONTROL_MAX_TEXT_UNITS = 4096;

export type DesktopScrollPhase = "began" | "changed" | "ended" | "momentumBegan" | "momentumChanged" | "momentumEnded";

export type RemoteModifier = "cmd" | "ctrl" | "option" | "shift";

export type RemoteLetter =
  | "A"
  | "B"
  | "C"
  | "D"
  | "E"
  | "F"
  | "G"
  | "H"
  | "I"
  | "J"
  | "K"
  | "L"
  | "M"
  | "N"
  | "O"
  | "P"
  | "Q"
  | "R"
  | "S"
  | "T"
  | "U"
  | "V"
  | "W"
  | "X"
  | "Y"
  | "Z";

export type RemoteDigit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

export type RemoteKeyCode =
  | "escape"
  | "tab"
  | "return"
  | "delete"
  | "space"
  | "left"
  | "right"
  | "up"
  | "down"
  | `ansi-${RemoteLetter}`
  | `ansi-${RemoteDigit}`
  | "ansi-comma"
  | "ansi-period"
  | "ansi-slash"
  | "ansi-semicolon"
  | "ansi-quote"
  | "ansi-leftbracket"
  | "ansi-rightbracket"
  | "ansi-backslash"
  | "ansi-minus"
  | "ansi-equal"
  | "ansi-grave";

export interface RemoteKeyEvent {
  code: RemoteKeyCode;
  modifiers: RemoteModifier[];
}

export interface DesktopControlConfiguration {
  type: "configure";
  initialFocusDelayMs: number;
  settleFocusDelayMs: number;
}

export type DesktopControlInput =
  | DesktopNavigationInput
  | DesktopControlConfiguration
  | { type: "pointer-move"; revision: number; dx: number; dy: number }
  // Absolute pointing: x/y are the source display's own coordinates, so the cursor lands where the
  // viewer is pointing rather than drifting by accumulated deltas. Used for a mouse, which has a
  // position to honour; touch has none and keeps the relative path above.
  | { type: "pointer-warp"; revision: number; x: number; y: number }
  | { type: "click"; button: "left" | "right"; focusRequestId?: string }
  // A drag, which `click` cannot express: press, move, release. A mouse has real buttons to hold;
  // a tap has none, so touch keeps sending `click`.
  | { type: "mouse-down"; button: "left" | "right" }
  | { type: "mouse-up"; button: "left" | "right" }
  | { type: "scroll"; dx: number; dy: number; phase: DesktopScrollPhase }
  | { type: "key-batch"; sequence: number; keys: RemoteKeyEvent[] }
  // Characters rather than key positions, which is what a paste actually is. `key-batch` sends
  // virtual key codes: they carry modifiers, which this cannot, but they can only express what a
  // US layout has a key for and they produce whatever the Mac's current layout puts there. Pasted
  // text routinely contains neither -- a curly quote, an em dash, an accent, an emoji -- so it
  // goes as itself and is typed as itself on the other side.
  | { type: "text"; sequence: number; text: string }
  | { type: "focus-query"; focusRequestId: string }
  | { type: "release-control" };

export type DesktopPointerInput = Extract<
  DesktopControlInput,
  { type: "pointer-move" | "pointer-warp" | "click" | "mouse-down" | "mouse-up" | "scroll" }
>;

export type TextInputEditability = "editable" | "non-editable" | "ambiguous";
export type TextInputFocusSource = "accessibility" | "cursor-tap-heuristic" | "none";
export type InputRejectionReason =
  | "accessibility-denied"
  | "channel-closed"
  | "helper-unavailable"
  | "malformed"
  | "not-owner"
  | "oversized"
  | "backpressured"
  | "unknown-key";

export interface DesktopTextFocusEvent {
  type: "text-focus";
  focusRequestId: string;
  editability: TextInputEditability;
  secure: boolean;
  source: TextInputFocusSource;
  role?: string;
  subrole?: string;
  cursorKind: DesktopCursorKind;
}

export type DesktopControlEvent =
  | DesktopNavigationEvent
  | WebrtcCursorEvent
  | DesktopTextFocusEvent
  | { type: "input-applied"; sequence: number }
  | { type: "input-rejected"; sequence?: number; reason: InputRejectionReason }
  | { type: "control-granted"; epoch: number }
  | { type: "control-revoked"; epoch: number };
