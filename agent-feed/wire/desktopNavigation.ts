/** Stable OS identities, never display ordinals or JavaScript uint64 numbers. */
export interface DesktopSpace {
  id: string;
  type: number;
}
export interface DesktopDisplay {
  id: string;
  label: string;
  isMain: boolean;
  activeSpaceId: string;
  spaces: DesktopSpace[];
}
export interface DesktopNavigationState {
  type: "desktop-state";
  revision: number;
  captureDisplayId: string;
  displays: DesktopDisplay[];
}
export type SpaceGesturePhase = "began" | "changed" | "ended" | "cancelled";
export type DesktopNavigationInput =
  | { type: "desktop-refresh" }
  | { type: "space-select"; requestId: string; displayId: string; spaceId: string }
  | {
      type: "space-gesture";
      gestureId: string;
      displayId: string;
      phase: SpaceGesturePhase;
      progress: number;
      velocityX: number;
    };
export type DesktopNavigationReason =
  | "navigation-unavailable"
  | "display-unavailable"
  | "space-unavailable"
  | "accessibility-denied"
  | "not-owner"
  | "malformed";
export type DesktopNavigationEvent =
  | DesktopNavigationState
  | { type: "desktop-unavailable"; reason: DesktopNavigationReason }
  | { type: "space-result"; requestId: string; status: "posted" | "rejected"; reason?: DesktopNavigationReason };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const desktopDisplayId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128 && /^[\w-]+$/.test(value);
export const desktopSpaceId = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const finite = (v: unknown, limit: number): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit;

export function desktopNavigationInput(value: unknown): DesktopNavigationInput | null {
  const v = object(value);
  if (!v) return null;
  if (v.type === "desktop-refresh") return { type: "desktop-refresh" };
  if (!desktopDisplayId(v.displayId)) return null;
  if (
    v.type === "space-select" &&
    typeof v.requestId === "string" &&
    UUID.test(v.requestId) &&
    desktopSpaceId(v.spaceId)
  ) {
    return { type: v.type, requestId: v.requestId, displayId: v.displayId, spaceId: v.spaceId };
  }
  if (
    v.type === "space-gesture" &&
    typeof v.gestureId === "string" &&
    UUID.test(v.gestureId) &&
    ["began", "changed", "ended", "cancelled"].includes(String(v.phase)) &&
    finite(v.progress, 1) &&
    finite(v.velocityX, 100_000) &&
    (v.phase === "changed" ||
      (v.phase === "ended" ? Math.abs(v.progress) === 1 : v.progress === 0 && v.velocityX === 0))
  ) {
    return {
      type: v.type,
      gestureId: v.gestureId,
      displayId: v.displayId,
      phase: v.phase as SpaceGesturePhase,
      progress: v.progress,
      velocityX: v.velocityX,
    };
  }
  return null;
}

const REASONS = new Set<DesktopNavigationReason>([
  "navigation-unavailable",
  "display-unavailable",
  "space-unavailable",
  "accessibility-denied",
  "not-owner",
  "malformed",
]);
export function desktopNavigationEvent(value: unknown): DesktopNavigationEvent | null {
  const v = object(value);
  if (!v) return null;
  if (v.type === "desktop-unavailable" && REASONS.has(v.reason as DesktopNavigationReason)) {
    return { type: v.type, reason: v.reason as DesktopNavigationReason };
  }
  if (
    v.type === "space-result" &&
    typeof v.requestId === "string" &&
    UUID.test(v.requestId) &&
    (v.status === "posted" || v.status === "rejected") &&
    (v.status === "posted" || REASONS.has(v.reason as DesktopNavigationReason))
  ) {
    return {
      type: v.type,
      requestId: v.requestId,
      status: v.status,
      ...(v.status === "rejected" ? { reason: v.reason as DesktopNavigationReason } : {}),
    };
  }
  if (
    v.type !== "desktop-state" ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 1 ||
    !desktopDisplayId(v.captureDisplayId) ||
    !Array.isArray(v.displays) ||
    v.displays.length > 32
  )
    return null;
  const displays: DesktopDisplay[] = [];
  const displayIds = new Set<string>();
  for (const item of v.displays) {
    const spaceIds = new Set<string>();
    const d = object(item);
    if (
      !d ||
      !desktopDisplayId(d.id) ||
      displayIds.has(d.id) ||
      typeof d.label !== "string" ||
      d.label.length > 256 ||
      typeof d.isMain !== "boolean" ||
      !desktopSpaceId(d.activeSpaceId) ||
      !Array.isArray(d.spaces) ||
      d.spaces.length > 256
    )
      return null;
    displayIds.add(d.id);
    const spaces: DesktopSpace[] = [];
    for (const item of d.spaces) {
      const s = object(item);
      if (
        !s ||
        !desktopSpaceId(s.id) ||
        spaceIds.has(s.id) ||
        !Number.isInteger(s.type) ||
        Number(s.type) < 0 ||
        Number(s.type) > 255
      )
        return null;
      spaceIds.add(s.id);
      spaces.push({ id: s.id, type: Number(s.type) });
    }
    if (!spaces.some((space) => space.id === d.activeSpaceId)) return null;
    displays.push({ id: d.id, label: d.label, isMain: d.isMain, activeSpaceId: d.activeSpaceId, spaces });
  }
  return { type: "desktop-state", revision: Number(v.revision), captureDisplayId: v.captureDisplayId, displays };
}
