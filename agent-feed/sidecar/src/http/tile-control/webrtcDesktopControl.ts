import type {
  DesktopControlInput,
  DesktopScrollPhase,
  RemoteKeyCode,
  RemoteKeyEvent,
  RemoteModifier,
} from "@agentdesk/agent-feed-wire";
import {
  DESKTOP_CONTROL_MAX_KEY_BATCH,
  DESKTOP_CONTROL_MAX_MESSAGE_BYTES,
  DESKTOP_CONTROL_MAX_TEXT_UNITS,
  desktopNavigationInput,
} from "@agentdesk/agent-feed-wire";

export const MAX_DESKTOP_CONTROL_MESSAGE_BYTES = DESKTOP_CONTROL_MAX_MESSAGE_BYTES;
export const MAX_DESKTOP_KEY_BATCH = DESKTOP_CONTROL_MAX_KEY_BATCH;
export const MAX_DESKTOP_TEXT_UNITS = DESKTOP_CONTROL_MAX_TEXT_UNITS;
const MAX_DELTA = 10_000;
// Wide enough for any display this can capture, including an 8K virtual one, without accepting a
// coordinate that could only be a bug.
const MAX_COORDINATE = 32_768;
const MAX_SEQUENCE = 0xffff_ffff;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SCROLL_PHASES = new Set<DesktopScrollPhase>([
  "began",
  "changed",
  "ended",
  "momentumBegan",
  "momentumChanged",
  "momentumEnded",
]);
const MODIFIERS = new Set<RemoteModifier>(["cmd", "ctrl", "option", "shift"]);
const CONTROL_KEYS = new Set<RemoteKeyCode>([
  "escape", "tab", "return", "delete", "space", "left", "right", "up", "down",
  "ansi-comma", "ansi-period", "ansi-slash", "ansi-semicolon", "ansi-quote",
  "ansi-leftbracket", "ansi-rightbracket", "ansi-backslash", "ansi-minus", "ansi-equal",
  "ansi-grave",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function boundedDelta(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DELTA;
}

/** An absolute source-display coordinate. Non-negative and inside any display this can capture. */
function boundedCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COORDINATE;
}

function positiveUint32(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_SEQUENCE;
}

function focusRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function remoteKeyCode(value: unknown): value is RemoteKeyCode {
  if (typeof value !== "string") return false;
  if (CONTROL_KEYS.has(value as RemoteKeyCode)) return true;
  return /^ansi-[A-Z]$/.test(value) || /^ansi-[0-9]$/.test(value);
}

function remoteKey(value: unknown): RemoteKeyEvent | null {
  const input = record(value);
  if (!input || !remoteKeyCode(input.code) || !Array.isArray(input.modifiers)) return null;
  const modifiers: RemoteModifier[] = [];
  for (const modifier of input.modifiers) {
    if (typeof modifier !== "string" || !MODIFIERS.has(modifier as RemoteModifier)) return null;
    if (!modifiers.includes(modifier as RemoteModifier)) modifiers.push(modifier as RemoteModifier);
  }
  return { code: input.code, modifiers };
}

/** Validate one v2 browser command. The validated object is serialized unchanged to native NDJSON. */
export function desktopControlInput(data: string | Buffer): DesktopControlInput | null {
  if (Buffer.byteLength(data) > MAX_DESKTOP_CONTROL_MESSAGE_BYTES) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(data.toString());
  } catch {
    return null;
  }
  const input = record(decoded);
  if (!input || typeof input.type !== "string") return null;
  switch (input.type) {
    case "desktop-refresh":
    case "space-select":
    case "space-gesture":
      return desktopNavigationInput(input);
    case "configure":
      return typeof input.initialFocusDelayMs === "number"
        && Number.isInteger(input.initialFocusDelayMs)
        && input.initialFocusDelayMs >= 0
        && input.initialFocusDelayMs <= 1_000
        && typeof input.settleFocusDelayMs === "number"
        && Number.isInteger(input.settleFocusDelayMs)
        && input.settleFocusDelayMs >= 0
        && input.settleFocusDelayMs <= 1_000
        ? {
            type: "configure",
            initialFocusDelayMs: input.initialFocusDelayMs,
            settleFocusDelayMs: input.settleFocusDelayMs,
          }
        : null;
    case "pointer-move":
      return positiveUint32(input.revision) && boundedDelta(input.dx) && boundedDelta(input.dy)
        ? { type: "pointer-move", revision: input.revision, dx: input.dx, dy: input.dy }
        : null;
    case "pointer-warp":
      return positiveUint32(input.revision) && boundedCoordinate(input.x) && boundedCoordinate(input.y)
        ? { type: "pointer-warp", revision: input.revision, x: input.x, y: input.y }
        : null;
    case "click":
      if (input.button !== "left" && input.button !== "right") return null;
      if (input.focusRequestId !== undefined && !focusRequestId(input.focusRequestId)) return null;
      return {
        type: "click",
        button: input.button,
        ...(typeof input.focusRequestId === "string" ? { focusRequestId: input.focusRequestId } : {}),
      };
    case "mouse-down":
    case "mouse-up":
      return input.button === "left" || input.button === "right"
        ? { type: input.type, button: input.button }
        : null;
    case "scroll":
      return boundedDelta(input.dx)
        && boundedDelta(input.dy)
        && typeof input.phase === "string"
        && SCROLL_PHASES.has(input.phase as DesktopScrollPhase)
        ? { type: "scroll", dx: input.dx, dy: input.dy, phase: input.phase as DesktopScrollPhase }
        : null;
    case "key-batch": {
      if (!positiveUint32(input.sequence) || !Array.isArray(input.keys)
          || input.keys.length === 0 || input.keys.length > MAX_DESKTOP_KEY_BATCH) return null;
      const keys: RemoteKeyEvent[] = [];
      for (const value of input.keys) {
        const key = remoteKey(value);
        if (!key) return null;
        keys.push(key);
      }
      return { type: "key-batch", sequence: input.sequence, keys };
    }
    case "text":
      // Only the length is checked. Which characters are typeable is not this layer's business:
      // the helper types the string as itself, so there is no vocabulary here to validate against.
      return positiveUint32(input.sequence)
        && typeof input.text === "string"
        && input.text.length > 0
        && input.text.length <= MAX_DESKTOP_TEXT_UNITS
        ? { type: "text", sequence: input.sequence, text: input.text }
        : null;
    case "focus-query":
      return focusRequestId(input.focusRequestId)
        ? { type: "focus-query", focusRequestId: input.focusRequestId }
        : null;
    case "release-control":
      return { type: "release-control" };
    default:
      return null;
  }
}

export function desktopControlRejectionReason(
  data: string | Buffer,
): "malformed" | "oversized" {
  if (Buffer.byteLength(data) > MAX_DESKTOP_CONTROL_MESSAGE_BYTES) return "oversized";
  try {
    const value = JSON.parse(data.toString()) as { type?: unknown; keys?: unknown; text?: unknown };
    if (value.type === "key-batch"
        && Array.isArray(value.keys)
        && value.keys.length > MAX_DESKTOP_KEY_BATCH) return "oversized";
    if (value.type === "text"
        && typeof value.text === "string"
        && value.text.length > MAX_DESKTOP_TEXT_UNITS) return "oversized";
  } catch {
    return "malformed";
  }
  return "malformed";
}

export function desktopControlLine(input: DesktopControlInput): string {
  return `${JSON.stringify(input)}\n`;
}
