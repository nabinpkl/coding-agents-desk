"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type {
  DesktopControlEvent,
  WebrtcCursorEvent,
  WebrtcTileSourceMetadata,
} from "@agentdesk/agent-feed-wire";
import { Hand, MousePointer2 } from "lucide-react";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import type { DesktopStreamState } from "./DesktopStreamState";
import {
  postTileTelemetry,
  TileStreamRtc,
  type DesktopControlTransport,
} from "./TileStreamRtc";
import { TileViewport, type ViewportGestureTelemetry } from "./TileViewport";
import { DesktopKeyboardChrome } from "./DesktopKeyboardChrome";
import { useDesktopKeyboard } from "./useDesktopKeyboard";

export function desktopDocumentFallbackHeight(
  viewportHeight: number,
  screenHeight: number,
): number | null {
  if (viewportHeight > 0 || !Number.isFinite(screenHeight) || screenHeight <= 0) return null;
  return Math.round(screenHeight);
}

/** The whole Mac desktop, with no window inventory or Desktop Park controls. */
export function DesktopViewer({ transport }: { transport: AgentHttpTransport }) {
  const [source, setSource] = useState<WebrtcTileSourceMetadata | null>(null);
  const [tile, setTile] = useState<DesktopStreamState>({ kind: "connecting" });
  const [controlTransport, setControlTransport] = useState<DesktopControlTransport | null>(null);
  const [pointerMode, setPointerMode] = useState(true);
  const cursorListeners = useRef(new Set<(event: WebrtcCursorEvent) => void>());
  const latestCursorEvents = useRef(new Map<WebrtcCursorEvent["type"], WebrtcCursorEvent>());

  useLayoutEffect(() => {
    const documentRoot = document.documentElement;
    const previousHeight = documentRoot.style.height;
    const applyHeight = () => {
      const fallback = desktopDocumentFallbackHeight(window.innerHeight, window.screen.height);
      documentRoot.style.height = fallback === null ? previousHeight : `${fallback}px`;
    };
    applyHeight();
    window.addEventListener("resize", applyHeight);
    window.addEventListener("orientationchange", applyHeight);
    return () => {
      window.removeEventListener("resize", applyHeight);
      window.removeEventListener("orientationchange", applyHeight);
      documentRoot.style.height = previousHeight;
    };
  }, []);

  const reportKeyboardTelemetry = useCallback((event: { phase: string; detail: Record<string, unknown> }) => {
    postTileTelemetry("display", {
      attempt: crypto.randomUUID(),
      phase: event.phase,
      detail: JSON.stringify(event.detail),
      elapsedMs: 0,
    }, transport);
  }, [transport]);
  const compatibleControlTransport = source?.desktopControlVersion === 2 ? controlTransport : null;
  const keyboard = useDesktopKeyboard({
    transport: compatibleControlTransport,
    report: reportKeyboardTelemetry,
  });
  const sendPointerInput = useCallback(
    (input: Parameters<DesktopControlTransport["send"]>[0]) => (
      source !== null && keyboard.sendControl(input)
    ),
    [keyboard.sendControl, source],
  );
  const publishControlEvent = useCallback((event: DesktopControlEvent) => {
    if (
      event.type === "cursor-applied"
      || event.type === "cursor-image"
      || event.type === "cursor-position"
    ) {
      if (event.type !== "cursor-applied") latestCursorEvents.current.set(event.type, event);
      for (const listener of cursorListeners.current) listener(event);
    }
    keyboard.handleControlEvent(event);
  }, [keyboard.handleControlEvent]);
  const subscribeCursorEvents = useCallback((listener: (event: WebrtcCursorEvent) => void) => {
    cursorListeners.current.add(listener);
    for (const event of latestCursorEvents.current.values()) listener(event);
    return () => cursorListeners.current.delete(listener);
  }, []);
  const applySourceMetadata = useCallback((metadata: WebrtcTileSourceMetadata) => {
    setSource((current) => {
      if (
        current
        && current.width === metadata.width
        && current.height === metadata.height
      ) return current;
      latestCursorEvents.current.clear();
      return metadata;
    });
  }, []);
  const reportGestureTelemetry = useCallback(
    (event: ViewportGestureTelemetry) => {
      postTileTelemetry("display", {
        attempt: event.gestureId,
        phase: event.phase,
        detail: JSON.stringify(event.detail),
        elapsedMs: event.elapsedMs,
      }, transport);
    },
    [transport],
  );

  const controlMismatch = source !== null && source.desktopControlVersion !== 2;
  const pointerReady = !controlMismatch
    && source !== null
    && compatibleControlTransport !== null
    && tile.kind === "playing";
  return (
    <main className="relative h-full overflow-hidden bg-black text-white">
      <TileViewport
        className="size-full"
        pointerMode={pointerMode && source !== null}
        sendPointerInput={sendPointerInput}
        keyboardPresented={keyboard.keyboardPresented}
        onPointerGestureStart={keyboard.consumePointerGesture}
        onBeforeRemoteClick={keyboard.beforeRemoteClick}
        onGestureTelemetry={reportGestureTelemetry}
        sourceWidth={source?.width}
        sourceHeight={source?.height}
        initialCursor={source?.cursor}
        subscribeCursorEvents={subscribeCursorEvents}
      >
        <TileStreamRtc
          windowID="display"
          fill
          httpTransport={transport}
          onState={setTile}
          onControlTransport={setControlTransport}
          onControlEvent={publishControlEvent}
          onSourceMetadata={applySourceMetadata}
        />
      </TileViewport>

      <div className={`pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between
        gap-3 bg-gradient-to-t from-black/65 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]
        pt-10 ${keyboard.keyboardPresented ? "bg-none" : ""}`}>
        {!keyboard.keyboardPresented ? (
          <p className="min-w-0 truncate font-mono text-[10px] text-white/70">
            {tile.kind === "playing" && source
              ? `${source.width}×${source.height} · ${tile.codec}`
              : tile.kind}
          </p>
        ) : <span />}
        <div className="pointer-events-auto flex shrink-0 rounded-lg bg-black/60 p-1 backdrop-blur">
          <DesktopKeyboardChrome
            captureRef={keyboard.captureRef}
            captureProps={keyboard.captureProps}
            shown={keyboard.keyboardPresented}
            available={compatibleControlTransport !== null}
            autoKeyboard={keyboard.autoKeyboard}
            modifiers={keyboard.modifiers}
            receipt={keyboard.receipt}
            localEcho={keyboard.localEcho}
            deliveryStatus={keyboard.deliveryStatus}
            bottom={keyboard.accessoryBottom}
            softwareKeyboardVisible={keyboard.softwareKeyboardVisible}
            onShow={keyboard.showManually}
            onHide={keyboard.hide}
            onAutoChange={keyboard.setAutoKeyboard}
            onKey={keyboard.sendChromeKey}
            onModifier={keyboard.tapModifier}
          />
          {!keyboard.keyboardPresented ? (
            <>
              <ModeButton
                active={!pointerMode}
                label="View"
                icon={<Hand className="size-3.5" aria-hidden />}
                onClick={() => setPointerMode(false)}
              />
              <ModeButton
                active={pointerMode}
                disabled={!pointerReady}
                label={controlMismatch
                  ? `Control v${source.desktopControlVersion || "unknown"} unsupported`
                  : pointerReady ? "Pointer" : "Input connecting"}
                icon={<MousePointer2 className="size-3.5" aria-hidden />}
                onClick={() => setPointerMode(true)}
              />
            </>
          ) : null}
        </div>
      </div>
    </main>
  );
}

function ModeButton({
  active,
  disabled = false,
  label,
  icon,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] transition-colors
        focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white
        disabled:cursor-wait disabled:opacity-50
        ${active ? "bg-white text-black" : "text-white/75 hover:bg-white/10 active:bg-white/15"}`}
    >
      {icon}
      {label}
    </button>
  );
}
