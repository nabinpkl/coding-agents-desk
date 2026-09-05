"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { desktopDisplayId, desktopNavigationEvent, type DesktopControlEvent, type DesktopNavigationState,
  type WebrtcTileSourceMetadata } from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import { DesktopViewerSurface } from "./DesktopViewerSurface";
import { DesktopNavigationChrome } from "./DesktopNavigationChrome";
import { useDesktopNavigation } from "./useDesktopNavigation";
import { CAPTURE_SCALE_MAX, CAPTURE_SCALE_MIN, postTileTelemetry, type DesktopControlTransport } from "./TileStreamRtc";
import type { DesktopStreamState } from "./DesktopStreamState";

export function desktopDocumentFallbackHeight(viewportHeight: number, screenHeight: number): number | null {
  if (viewportHeight > 0 || !Number.isFinite(screenHeight) || screenHeight <= 0) return null;
  return Math.round(screenHeight);
}

const CAPTURE_SCALE_STORAGE_KEY = "agentdesk.desktop.captureScale";

/**
 * Which monitor this session was last looking at, remembered per session because display ids belong
 * to the session that owns them: the console's monitors and a Screen Sharing session's synthesised
 * ones are different sets, and restoring one into the other would ask for a monitor that is not
 * there. A remembered id that has since gone answers 409 with a replacement, which the viewer
 * already knows how to adopt, so a stale value costs one redirect rather than a dead screen.
 */
function displayStorageKey(scope: string): string {
  return `agentdesk.desktop.display:${scope}`;
}

function rememberedDisplay(scope: string): string | undefined {
  try {
    const stored = localStorage.getItem(displayStorageKey(scope));
    return desktopDisplayId(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

function clampCaptureScale(value: number): number {
  return Math.min(CAPTURE_SCALE_MAX, Math.max(CAPTURE_SCALE_MIN, value));
}

interface ViewerSlotState {
  id: number;
  displayId?: string;
  source?: WebrtcTileSourceMetadata;
  control?: DesktopControlTransport | null;
  snapshot?: DesktopNavigationState;
  keyboard?: boolean;
  ready?: boolean;
  error?: string;
}
interface ViewerState { active: number; pending: number | null; slots: ViewerSlotState[]; notice: string | null }

/** A monitor handover replaces one source, never the identity of an in-flight source. */
export function DesktopViewer({ transport, scope = "default" }: {
  transport: AgentHttpTransport;
  /** Names the login session, so a remembered monitor is restored into the session it belongs to. */
  scope?: string;
}) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.style.height;
    const apply = () => {
      const fallback = desktopDocumentFallbackHeight(window.innerHeight, window.screen.height);
      root.style.height = fallback === null ? previous : `${fallback}px`;
    };
    apply();
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
      root.style.height = previous;
    };
  }, []);
  // Seeded rather than switched into after connecting: opening straight onto the remembered
  // monitor is one negotiation, where selecting it afterwards would be a visible handover.
  const [viewer, setViewer] = useState<ViewerState>(() => ({
    active: 1, pending: null, slots: [{ id: 1, displayId: rememberedDisplay(scope) }], notice: null,
  }));
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  const sequence = useRef(1);
  const [chromeHeight, setChromeHeight] = useState(0);
  // The capture-resolution knob lives here, above the slots, so it survives a monitor handover and
  // is remembered between visits. Clamped on the way in and out so a hand-edited value cannot push
  // the encoder past its bounds.
  const [captureScale, setCaptureScaleState] = useState<number>(() => {
    try {
      const stored = Number.parseFloat(localStorage.getItem(CAPTURE_SCALE_STORAGE_KEY) ?? "");
      return Number.isFinite(stored) ? clampCaptureScale(stored) : 1;
    } catch {
      return 1;
    }
  });
  const setCaptureScale = useCallback((value: number) => {
    const clamped = clampCaptureScale(value);
    setCaptureScaleState(clamped);
    try {
      localStorage.setItem(CAPTURE_SCALE_STORAGE_KEY, String(clamped));
    } catch {
      // a private window without storage still gets the live value for this session
    }
  }, []);
  const active = viewer.slots.find((slot) => slot.id === viewer.active)!;
  const activeDisplayId = active.source?.displayId;
  const report = useCallback((phase: string, detail: Record<string, unknown>) => {
    postTileTelemetry("display", { phase, attempt: crypto.randomUUID(),
      elapsedMs: 0, detail: JSON.stringify(detail) }, transport);
  }, [transport]);
  const navigation = useDesktopNavigation({
    transport: viewer.pending === null && active.source?.desktopNavigationVersion === 1 ? active.control ?? null : null,
    displayId: activeDisplayId, report,
  });
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const patchSlot = useCallback((id: number, patch: Partial<ViewerSlotState>) => {
    setViewer((current) => {
      if (!current.slots.some((slot) => slot.id === id)) return current;
      const slots = current.slots.map((slot) => slot.id === id ? { ...slot, ...patch } : slot);
      if (patch.ready && current.pending === id) {
        return { active: id, pending: null, slots: slots.filter((slot) => slot.id === id), notice: current.notice };
      }
      return { ...current, slots };
    });
  }, []);
  const event = useCallback((id: number, value: DesktopControlEvent) => {
    const current = viewerRef.current;
    if (!current.slots.some((slot) => slot.id === id)) return;
    if (id === current.active) navigationRef.current.handleEvent(value);
    const decoded = desktopNavigationEvent(value);
    if (decoded?.type === "desktop-state") patchSlot(id, { snapshot: decoded });
  }, [patchSlot]);
  const selectDisplay = useCallback((displayId?: string, notice: string | null = null) => {
    const current = viewerRef.current;
    const old = current.slots.find((slot) => slot.id === current.active);
    if (displayId && old?.source?.displayId === displayId && current.pending === null && old.ready) return;
    navigationRef.current.cancel();
    old?.control?.send({ type: "release-control" });
    try {
      if (displayId) localStorage.setItem(displayStorageKey(scope), displayId);
      else localStorage.removeItem(displayStorageKey(scope));
    } catch {
      // a private window still gets the choice for this session
    }
    const id = ++sequence.current;
    report("navigation-display", { phase: "requested", displayId: displayId ?? "main", generation: id });
    setViewer({ active: current.active, pending: id,
      slots: [...current.slots.filter((slot) => slot.id === current.active), { id, displayId }], notice });
  }, [report, scope]);
  const displaySnapshot = active.snapshot ?? navigation.model.snapshot;
  const displays = displaySnapshot?.displays ?? [];
  const missingDisplay = !!activeDisplayId && !!displaySnapshot
    && !displays.some((display) => display.id === activeDisplayId);
  const canInteract = viewer.pending === null && !missingDisplay;
  const displayUnavailable = useCallback((id: number, replacement: string) => {
    const current = viewerRef.current;
    if (id !== (current.pending ?? current.active)) return;
    selectDisplay(replacement, "Monitor disconnected. Now viewing the remaining main monitor.");
  }, [selectDisplay]);
  useEffect(() => {
    if (!activeDisplayId || !displaySnapshot || viewer.pending !== null
        || displays.some((display) => display.id === activeDisplayId)) return;
    const replacement = displays.find((display) => display.isMain) ?? displays[0];
    if (replacement) {
      selectDisplay(replacement.id, `Monitor disconnected. Now viewing ${replacement.label || "Main"}.`);
    }
  }, [activeDisplayId, displaySnapshot, displays, viewer.pending, selectDisplay]);
  /**
   * Give up on a monitor switch and go back to the one that still works.
   *
   * Abandoning has to clear `pending`, not just record an error: interactivity is gated on
   * `pending === null`, so a handover left in flight takes the input controls away with it and
   * strands the viewer with no way to click -- including no way to retry, or to take back input
   * ownership, which the sidecar hands to whoever acts next.
   */
  const abandonHandover = useCallback((id: number, notice: string) => {
    setViewer((current) => {
      if (current.pending !== id) return current;
      return {
        active: current.active,
        pending: null,
        slots: current.slots.filter((slot) => slot.id === current.active),
        notice,
      };
    });
  }, []);
  useEffect(() => {
    const id = viewer.pending;
    if (id === null) return;
    const timeout = setTimeout(
      () => abandonHandover(id, "Could not switch monitor. Still showing the previous one."),
      15_000,
    );
    return () => clearTimeout(timeout);
  }, [viewer.pending, abandonHandover]);
  const pending = viewer.slots.find((slot) => slot.id === viewer.pending);
  const error = pending?.error ?? active.error
    ?? (missingDisplay && displays.length === 0 ? "No monitor is available" : undefined)
    ?? (active.source && active.source.desktopNavigationVersion !== 1
      ? "Desktop navigation unavailable. Update the standalone helper." : undefined);
  const onDisplay = useCallback((id: string) => selectDisplay(id), [selectDisplay]);
  const navigationChrome = active.source?.desktopNavigationVersion === 1 ? (
    <DesktopNavigationChrome model={navigation.model} displays={displays} displayId={activeDisplayId}
      disabled={!active.control || !canInteract || displays.length === 0}
      switching={viewer.pending !== null} hidden={!!active.keyboard}
      onDisplay={onDisplay} onSelect={navigation.select} onBegin={navigation.begin}
      onMove={navigation.move} onEnd={navigation.end} onCancel={navigation.cancel}
      onRefresh={navigation.refresh} />
  ) : null;
  return (
    <main className="relative size-full overflow-hidden bg-black text-white"
      style={{ "--desktop-chrome-clearance": `${chromeHeight + 8}px` } as CSSProperties}>
      {viewer.slots.map((slot) => (
        <div key={slot.id} className="absolute inset-0"
          aria-hidden={slot.id !== viewer.active}
          style={{ opacity: slot.id === viewer.active ? 1 : 0,
            pointerEvents: slot.id === viewer.active && canInteract ? "auto" : "none" }}>
          <ViewerSlot slot={slot} transport={transport} interactive={slot.id === viewer.active && canInteract}
            navigation={slot.id === viewer.active ? navigationChrome : null}
            onChromeHeight={slot.id === viewer.active ? setChromeHeight : undefined}
            captureScale={captureScale} onCaptureScale={setCaptureScale}
            patch={patchSlot} event={event} displayUnavailable={displayUnavailable} />
        </div>
      ))}
      {viewer.pending !== null || viewer.notice || error ? (
        <div role="status" className="pointer-events-auto absolute inset-x-3 top-3 rounded-md bg-black/85 px-3 py-2 text-xs">
          {error || (viewer.pending !== null ? "Switching display…" : viewer.notice)}
          {error ? <button type="button" className="ml-3 underline focus-visible:outline-2"
            onClick={() => selectDisplay(pending?.displayId ?? active.displayId)}>Retry</button> : null}
          {viewer.pending === null && viewer.notice ? <button type="button" aria-label="Dismiss display notice"
            className="ml-3 underline" onClick={() => setViewer((state) => ({ ...state, notice: null }))}>Dismiss</button> : null}
        </div>
      ) : null}
    </main>
  );
}

function ViewerSlot({ slot, transport, interactive, navigation, onChromeHeight, captureScale, onCaptureScale, patch, event, displayUnavailable }: {
  slot: ViewerSlotState; transport: AgentHttpTransport; interactive: boolean;
  navigation: ReactNode;
  onChromeHeight?: (height: number) => void;
  captureScale: number;
  onCaptureScale: (value: number) => void;
  patch: (id: number, patch: Partial<ViewerSlotState>) => void;
  event: (id: number, event: DesktopControlEvent) => void;
  displayUnavailable: (id: number, replacement: string) => void;
}) {
  const source = useCallback((value: WebrtcTileSourceMetadata) => patch(slot.id, { source: value }), [slot.id, patch]);
  const control = useCallback((value: DesktopControlTransport | null) => patch(slot.id, { control: value }), [slot.id, patch]);
  const onEvent = useCallback((value: DesktopControlEvent) => event(slot.id, value), [slot.id, event]);
  const ready = useCallback(() => patch(slot.id, { ready: true, error: undefined }), [slot.id, patch]);
  const keyboard = useCallback((shown: boolean) => patch(slot.id, { keyboard: shown }), [slot.id, patch]);
  const unavailable = useCallback((replacement: string) => displayUnavailable(slot.id, replacement), [slot.id, displayUnavailable]);
  const state = useCallback((value: DesktopStreamState) => {
    if (value.kind === "error" || value.kind === "unsupported") patch(slot.id, { error: value.message });
  }, [slot.id, patch]);
  return <DesktopViewerSurface transport={transport} displayId={slot.displayId} interactive={interactive}
    navigation={navigation} onChromeHeight={onChromeHeight}
    captureScale={captureScale} onCaptureScale={onCaptureScale}
    onSource={source} onTransport={control} onEvent={onEvent} onFirstFrame={ready} onKeyboard={keyboard}
    onState={state} onDisplayUnavailable={unavailable} />;
}
