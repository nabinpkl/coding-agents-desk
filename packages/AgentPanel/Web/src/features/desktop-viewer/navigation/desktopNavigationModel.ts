import type { DesktopDisplay, DesktopNavigationState } from "@agentdesk/agent-feed-wire";

export const NAVIGATION_TUNING = {
  collapsedHeight: 26,
  pillWidth: 40,
  pillHeight: 30,
  gap: 10,
  padding: 3,
  commitDistance: 0.5,
  commitVelocity: 800,
  slop: 6,
  timeoutMs: 2000,
};
export type NavigationMotion =
  | { kind: "idle" }
  | { kind: "dragging"; id: string; translation: number }
  | { kind: "pending"; id: string; target: string; durationMs: number };
export interface NavigationModel {
  snapshot: DesktopNavigationState | null;
  motion: NavigationMotion;
  error: string | null;
}
export type NavigationAction =
  | { type: "snapshot"; snapshot: DesktopNavigationState }
  | { type: "drag"; id: string; translation: number }
  | { type: "pending"; id: string; target: string; steps: number }
  | { type: "cancel" }
  | { type: "failure"; id?: string; reason: string }
  | { type: "reset" };
export const initialNavigationModel: NavigationModel = { snapshot: null, motion: { kind: "idle" }, error: null };

export function navigationReducer(state: NavigationModel, action: NavigationAction): NavigationModel {
  switch (action.type) {
    case "reset":
      return initialNavigationModel;
    case "cancel":
      return { ...state, motion: { kind: "idle" } };
    case "drag":
      return { ...state, motion: { kind: "dragging", id: action.id, translation: action.translation }, error: null };
    case "pending":
      return {
        ...state,
        error: null,
        motion: {
          kind: "pending",
          id: action.id,
          target: action.target,
          durationMs: Math.min(500, 180 + Math.max(0, action.steps - 1) * 100),
        },
      };
    case "failure":
      if (action.id && (state.motion.kind === "idle" || action.id !== state.motion.id)) return state;
      return { ...state, motion: { kind: "idle" }, error: action.reason };
    case "snapshot": {
      const previous = state.snapshot;
      if (
        previous?.captureDisplayId === action.snapshot.captureDisplayId &&
        previous.revision >= action.snapshot.revision
      )
        return state;
      const nextDisplay = selectedNavigationDisplay(action.snapshot);
      const oldDisplay = selectedNavigationDisplay(previous);
      const topologyChanged =
        oldDisplay?.id !== nextDisplay?.id ||
        oldDisplay?.spaces.map((space) => `${space.id}:${space.type}`).join(",") !==
          nextDisplay?.spaces.map((space) => `${space.id}:${space.type}`).join(",");
      const externallyMoved =
        state.motion.kind === "dragging" && oldDisplay?.activeSpaceId !== nextDisplay?.activeSpaceId;
      const reached = state.motion.kind === "pending" && nextDisplay?.activeSpaceId === state.motion.target;
      return {
        snapshot: action.snapshot,
        error: state.error,
        motion: topologyChanged || externallyMoved || reached ? { kind: "idle" } : state.motion,
      };
    }
  }
}

export function selectedNavigationDisplay(snapshot: DesktopNavigationState | null): DesktopDisplay | undefined {
  return snapshot?.displays.find((display) => display.id === snapshot.captureDisplayId);
}

/** Positive means next in the OS sequence, independent of Dock's raw event convention. */
export function navigationStep(translation: number, velocity: number, width: number, macDirection: boolean): number {
  const travel = (macDirection ? 1 : -1) * translation;
  const speed = (macDirection ? 1 : -1) * velocity;
  if (Math.abs(travel) / Math.max(1, width) > NAVIGATION_TUNING.commitDistance) return Math.sign(travel);
  if (Math.abs(speed) > NAVIGATION_TUNING.commitVelocity && (travel === 0 || travel * speed > 0)) {
    return Math.sign(speed);
  }
  return 0;
}

export function navigationGeometry(count: number, viewportWidth: number, activeIndex: number) {
  const { pillWidth, gap } = NAVIGATION_TUNING;
  const rowWidth = Math.max(0, count * pillWidth + (count - 1) * gap);
  const inset = Math.max(0, (viewportWidth - rowWidth) / 2);
  const maximum = Math.max(0, rowWidth - viewportWidth);
  const tileLeft = inset + Math.max(0, activeIndex) * (pillWidth + gap);
  const offset = Math.min(maximum, Math.max(0, tileLeft + pillWidth / 2 - viewportWidth / 2));
  return { rowWidth, inset, offset, maximum, indicatorLeft: tileLeft - offset };
}
