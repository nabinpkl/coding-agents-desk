import { useCallback, useEffect, useRef, useState } from "react";
import { desktopNavigationEvent, type DesktopControlEvent, type DesktopControlInput } from "@agentdesk/agent-feed-wire";
import type { DesktopControlTransport } from "../tile-stream/TileStreamRtc";
import { initialNavigationModel, navigationReducer, navigationStep, NAVIGATION_TUNING,
  selectedNavigationDisplay, type NavigationAction } from "./desktopNavigationModel";

export type NavigationReport = (phase: string, detail: Record<string, unknown>) => void;
export function useDesktopNavigation({
  transport, displayId, report,
}: { transport: DesktopControlTransport | null; displayId?: string; report: NavigationReport }) {
  const [model, setModel] = useState(initialNavigationModel);
  const modelRef = useRef(model);
  const current = useRef({ transport, displayId, report });
  current.current = { transport, displayId, report };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(0);
  const frame = useRef(0);
  const queued = useRef<DesktopControlInput | null>(null);

  const update = useCallback((action: NavigationAction) => {
    const next = navigationReducer(modelRef.current, action);
    modelRef.current = next;
    setModel(next);
    if (next.motion.kind === "idle" && timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const send = useCallback((input: DesktopControlInput) => {
    const result = current.current.transport?.send(input) ?? "channel-closed";
    if (result !== "sent") {
      if (input.type === "space-gesture") current.current.transport?.abort?.();
      current.current.report("navigation-rejected", { reason: result, type: input.type });
      update({ type: "failure", reason: result });
      return false;
    }
    return true;
  }, [update]);

  const clearFrame = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    queued.current = null;
  }, []);

  const cancel = useCallback(() => {
    clearFrame();
    const motion = modelRef.current.motion;
    if (motion.kind === "dragging" && current.current.displayId) {
      send({ type: "space-gesture", gestureId: motion.id, displayId: current.current.displayId,
        phase: "cancelled", progress: 0, velocityX: 0 });
      current.current.report("navigation-gesture", { id: motion.id, phase: "cancelled" });
    }
    update({ type: "cancel" });
  }, [clearFrame, send, update]);

  const waitForTarget = useCallback((id: string, target: string, steps: number) => {
    if (timer.current !== null) clearTimeout(timer.current);
    update({ type: "pending", id, target, steps });
    timer.current = setTimeout(() => {
      current.current.report("navigation-rejected", { id, reason: "timeout" });
      update({ type: "failure", id, reason: "Desktop switch timed out" });
      send({ type: "desktop-refresh" });
    }, NAVIGATION_TUNING.timeoutMs);
  }, [send, update]);

  const handleEvent = useCallback((event: DesktopControlEvent) => {
    if (event.type === "control-revoked") {
      // Ownership is already gone; do not send a cancellation that could reacquire it.
      clearFrame();
      update({ type: "failure", reason: "Control moved to another viewer" });
      return;
    }
    const navigation = desktopNavigationEvent(event);
    if (!navigation) return;
    if (navigation.type === "desktop-state") {
      if (current.current.displayId && navigation.captureDisplayId !== current.current.displayId) return;
      const previous = modelRef.current;
      const next = navigationReducer(previous, { type: "snapshot", snapshot: navigation });
      if (previous.motion.kind === "dragging" && next.motion.kind === "idle") cancel();
      if (previous.motion.kind === "pending" && next.motion.kind === "idle") {
        const active = selectedNavigationDisplay(navigation)?.activeSpaceId;
        current.current.report("navigation-settled", { id: previous.motion.id,
          reached: active === previous.motion.target, elapsedMs: Math.round(performance.now() - startedAt.current) });
      }
      update({ type: "snapshot", snapshot: navigation });
    } else if (navigation.type === "desktop-unavailable") {
      cancel();
      update({ type: "failure", reason: navigation.reason });
    } else if (navigation.status === "rejected") {
      const motion = modelRef.current.motion;
      if (motion.kind === "idle" || motion.id !== navigation.requestId) return;
      clearFrame();
      update({ type: "failure", id: navigation.requestId, reason: navigation.reason! });
    }
  }, [cancel, clearFrame, update]);

  useEffect(() => {
    clearFrame();
    update({ type: "reset" });
    if (transport) transport.send({ type: "desktop-refresh" });
    return () => {
      clearFrame();
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      const motion = modelRef.current.motion;
      if (motion.kind === "dragging" && displayId) {
        transport?.send({ type: "space-gesture", gestureId: motion.id, displayId,
          phase: "cancelled", progress: 0, velocityX: 0 });
      }
    };
  }, [transport, displayId, update, clearFrame]);

  useEffect(() => {
    const hidden = () => { if (document.visibilityState === "hidden") cancel(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [cancel]);

  const select = useCallback((spaceId: string) => {
    const display = selectedNavigationDisplay(modelRef.current.snapshot);
    if (!display || display.id !== current.current.displayId || display.activeSpaceId === spaceId) return;
    cancel();
    const id = crypto.randomUUID();
    const from = display.spaces.findIndex((space) => space.id === display.activeSpaceId);
    const to = display.spaces.findIndex((space) => space.id === spaceId && space.type === 0);
    if (from < 0 || to < 0) return;
    startedAt.current = performance.now();
    if (send({ type: "space-select", requestId: id, displayId: display.id, spaceId })) {
      waitForTarget(id, spaceId, Math.abs(to - from));
      current.current.report("navigation-select", { id, displayId: display.id, spaceId });
    }
  }, [cancel, send, waitForTarget]);

  const begin = useCallback((): string | null => {
    if (!current.current.displayId || !current.current.transport
        || selectedNavigationDisplay(modelRef.current.snapshot)?.id !== current.current.displayId) return null;
    cancel();
    const id = crypto.randomUUID();
    startedAt.current = performance.now();
    if (!send({ type: "space-gesture", gestureId: id, displayId: current.current.displayId,
      phase: "began", progress: 0, velocityX: 0 })) return null;
    update({ type: "drag", id, translation: 0 });
    current.current.report("navigation-gesture", { id, phase: "began" });
    return id;
  }, [cancel, send, update]);

  const move = useCallback((translation: number, velocity: number, width: number, macDirection: boolean) => {
    const motion = modelRef.current.motion;
    if (motion.kind !== "dragging" || !current.current.displayId) return;
    update({ type: "drag", id: motion.id, translation });
    queued.current = { type: "space-gesture", gestureId: motion.id, displayId: current.current.displayId,
      phase: "changed", progress: Math.max(-1, Math.min(1, translation / Math.max(1, width))) * (macDirection ? 1 : -1),
      velocityX: velocity * (macDirection ? 1 : -1) };
    if (!frame.current) frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const input = queued.current;
      queued.current = null;
      if (input && !send(input)) cancel();
    });
  }, [cancel, send, update]);

  const end = useCallback((translation: number, velocity: number, width: number, macDirection: boolean) => {
    clearFrame();
    const motion = modelRef.current.motion;
    const display = selectedNavigationDisplay(modelRef.current.snapshot);
    if (motion.kind !== "dragging" || !display) return;
    const step = navigationStep(translation, velocity, width, macDirection);
    const index = display.spaces.findIndex((space) => space.id === display.activeSpaceId);
    const target = index >= 0 ? display.spaces[index + step] : undefined;
    if (!step || !target) { cancel(); return; }
    if (send({ type: "space-gesture", gestureId: motion.id, displayId: display.id,
      phase: "ended", progress: step, velocityX: velocity * (macDirection ? 1 : -1) })) {
      waitForTarget(motion.id, target.id, 1);
      current.current.report("navigation-gesture", { id: motion.id, phase: "ended", step });
    }
  }, [cancel, clearFrame, send, waitForTarget]);

  return { model, handleEvent, select, begin, move, end, cancel, refresh: () => send({ type: "desktop-refresh" }) };
}
