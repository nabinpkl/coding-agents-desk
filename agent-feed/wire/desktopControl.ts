import type { DesktopCursorKind, WebrtcCursorEvent } from "./desktop.ts";
import type { DesktopNavigationEvent, DesktopNavigationInput } from "./desktopNavigation.ts";

export const DESKTOP_CONTROL_MAX_MESSAGE_BYTES = 16 * 1024;
export const DESKTOP_CONTROL_MAX_KEY_BATCH = 256;

export type DesktopScrollPhase =
  | "began"
  | "changed"
  | "ended"
  | "momentumBegan"
  | "momentumChanged"
  | "momentumEnded";

export type RemoteModifier = "cmd" | "ctrl" | "option" | "shift";

export type RemoteLetter =
  | "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L" | "M"
  | "N" | "O" | "P" | "Q" | "R" | "S" | "T" | "U" | "V" | "W" | "X" | "Y" | "Z";

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
  | { type: "scroll"; dx: number; dy: number; phase: DesktopScrollPhase }
  | { type: "key-batch"; sequence: number; keys: RemoteKeyEvent[] }
  | { type: "focus-query"; focusRequestId: string }
  | { type: "release-control" };

export type DesktopPointerInput = Extract<
  DesktopControlInput,
  { type: "pointer-move" | "pointer-warp" | "click" | "scroll" }
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
