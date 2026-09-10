import { createHash } from "node:crypto";
import { desktopNavigationEvent, type DesktopNavigationState } from "@agentdesk/agent-feed-wire";
import type {
  DesktopControlEvent,
  DesktopCursorKind,
  DesktopTextFocusEvent,
  InputRejectionReason,
  TextInputEditability,
  TextInputFocusSource,
  WebrtcCursorApplied,
  WebrtcCursorEvent,
  WebrtcCursorImage,
  WebrtcCursorPosition,
} from "@agentdesk/agent-feed-wire";

const MAX_CURSOR_PNG_BYTES = 1_048_576;
const MAX_CURSOR_POINTS = 512;
const MAX_SOURCE_COORDINATE = 100_000;
const MAX_SEQUENCE = 0xffff_ffff;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_KINDS = new Set<DesktopCursorKind>([
  "arrow", "ibeam", "pointingHand", "resize", "unknown",
]);
const EDITABILITY = new Set<TextInputEditability>(["editable", "non-editable", "ambiguous"]);
const FOCUS_SOURCES = new Set<TextInputFocusSource>([
  "accessibility", "cursor-tap-heuristic", "none",
]);
const REJECTION_REASONS = new Set<InputRejectionReason>([
  "accessibility-denied", "channel-closed", "helper-unavailable", "malformed", "not-owner",
  "oversized", "backpressured", "unknown-key",
]);

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function positiveUint32(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_SEQUENCE;
}

function cursorPosition(value: Record<string, unknown>): WebrtcCursorPosition | null {
  if (value.type !== "cursor-position"
      || !finite(value.x, 0, MAX_SOURCE_COORDINATE)
      || !finite(value.y, 0, MAX_SOURCE_COORDINATE)) return null;
  return { type: "cursor-position", x: value.x, y: value.y };
}

function cursorApplied(value: Record<string, unknown>): WebrtcCursorApplied | null {
  if (value.type !== "cursor-applied" || !positiveUint32(value.revision)
      || !finite(value.x, 0, MAX_SOURCE_COORDINATE)
      || !finite(value.y, 0, MAX_SOURCE_COORDINATE)) return null;
  return { type: "cursor-applied", revision: value.revision, x: value.x, y: value.y };
}

function cursorImage(value: Record<string, unknown>): WebrtcCursorImage | null {
  if (value.type !== "cursor-image" || typeof value.png !== "string" || value.png.length === 0
      || value.png.length > MAX_CURSOR_PNG_BYTES * 2 || !finite(value.hotspotXFrac, 0, 1)
      || !finite(value.hotspotYFrac, 0, 1) || !finite(value.widthPoints, 0.01, MAX_CURSOR_POINTS)
      || !finite(value.heightPoints, 0.01, MAX_CURSOR_POINTS) || typeof value.hidden !== "boolean"
      || typeof value.cursorKind !== "string"
      || !CURSOR_KINDS.has(value.cursorKind as DesktopCursorKind)) return null;
  const png = Buffer.from(value.png, "base64");
  if (png.length === 0 || png.length > MAX_CURSOR_PNG_BYTES
      || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  return {
    type: "cursor-image",
    hash: createHash("sha256").update(png).digest("hex"),
    png: value.png,
    hotspotXFrac: value.hotspotXFrac,
    hotspotYFrac: value.hotspotYFrac,
    widthPoints: value.widthPoints,
    heightPoints: value.heightPoints,
    hidden: value.hidden,
    cursorKind: value.cursorKind as DesktopCursorKind,
  };
}

function boundedOptionalString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && Buffer.byteLength(value) <= 256 ? value : null;
}

function textFocus(value: Record<string, unknown>): DesktopTextFocusEvent | null {
  const role = boundedOptionalString(value.role);
  const subrole = boundedOptionalString(value.subrole);
  if (value.type !== "text-focus" || typeof value.focusRequestId !== "string"
      || !UUID.test(value.focusRequestId) || typeof value.editability !== "string"
      || !EDITABILITY.has(value.editability as TextInputEditability) || typeof value.secure !== "boolean"
      || typeof value.source !== "string" || !FOCUS_SOURCES.has(value.source as TextInputFocusSource)
      || typeof value.cursorKind !== "string"
      || !CURSOR_KINDS.has(value.cursorKind as DesktopCursorKind) || role === null || subrole === null) {
    return null;
  }
  return {
    type: "text-focus",
    focusRequestId: value.focusRequestId,
    editability: value.editability as TextInputEditability,
    secure: value.secure,
    source: value.source as TextInputFocusSource,
    cursorKind: value.cursorKind as DesktopCursorKind,
    ...(role === undefined ? {} : { role }),
    ...(subrole === undefined ? {} : { subrole }),
  };
}

function delivery(value: Record<string, unknown>): DesktopControlEvent | null {
  if (value.type === "input-applied" && positiveUint32(value.sequence)) {
    return { type: "input-applied", sequence: value.sequence };
  }
  if (value.type === "input-rejected" && typeof value.reason === "string"
      && REJECTION_REASONS.has(value.reason as InputRejectionReason)
      && (value.sequence === undefined || positiveUint32(value.sequence))) {
    return {
      type: "input-rejected",
      reason: value.reason as InputRejectionReason,
      ...(typeof value.sequence === "number" ? { sequence: value.sequence } : {}),
    };
  }
  return null;
}

/** Retains replayable cursor/topology snapshots, never input or gesture results. */
export class WebrtcDesktopControlEvents {
  private image: WebrtcCursorImage | null = null;
  private position: WebrtcCursorPosition | null = null;
  private navigation: DesktopNavigationState | null = null;
  private navigationFailure: Extract<DesktopControlEvent, { type: "desktop-unavailable" }> | null = null;

  accept(payload: Uint8Array): DesktopControlEvent | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder().decode(payload));
    } catch {
      return null;
    }
    if (typeof decoded !== "object" || decoded === null) return null;
    const value = decoded as Record<string, unknown>;
    if (["desktop-state", "desktop-unavailable", "space-result"].includes(String(value.type))
        && payload.byteLength > 16 * 1024) return null;
    const next = value.type === "cursor-image"
      ? cursorImage(value)
      : value.type === "cursor-applied"
        ? cursorApplied(value)
        : value.type === "cursor-position"
          ? cursorPosition(value)
          : value.type === "text-focus"
            ? textFocus(value)
            : delivery(value) ?? desktopNavigationEvent(value);
    if (!next) return null;
    if (next.type === "cursor-image") {
      if (next.hash === this.image?.hash) return null;
      this.image = next;
    } else if (next.type === "cursor-position") {
      if (next.x === this.position?.x && next.y === this.position?.y) return null;
      this.position = next;
    } else if (next.type === "cursor-applied") {
      this.position = { type: "cursor-position", x: next.x, y: next.y };
    } else if (next.type === "desktop-state") {
      if (this.navigation && next.revision <= this.navigation.revision) return null;
      this.navigation = next;
      this.navigationFailure = null;
    } else if (next.type === "desktop-unavailable") {
      this.navigationFailure = next;
    }
    return next;
  }

  cursorSnapshot(): WebrtcCursorEvent[] {
    const snapshot: WebrtcCursorEvent[] = [];
    if (this.image) snapshot.push(this.image);
    if (this.position) snapshot.push(this.position);
    return snapshot;
  }

  snapshot(): DesktopControlEvent[] {
    return [...this.cursorSnapshot(), ...(this.navigation ? [this.navigation] : []),
      ...(this.navigationFailure ? [this.navigationFailure] : [])];
  }

  captureDisplayMissing(displayId: string): boolean {
    return this.navigation !== null && !this.navigation.displays.some((display) => display.id === displayId);
  }
}
