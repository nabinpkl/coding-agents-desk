"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  DesktopControlEvent,
  DesktopCursorKind,
  WebrtcCursorEvent,
  WebrtcTileSourceMetadata,
} from "@agentdesk/agent-feed-wire";
import { Crop, Crosshair, Hand, Layers, MousePointer2 } from "lucide-react";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import type { DesktopStreamState } from "./DesktopStreamState";
import {
  CAPTURE_SCALE_MAX,
  CAPTURE_SCALE_MIN,
  postTileTelemetry,
  TileStreamRtc,
  type DesktopControlTransport,
} from "./TileStreamRtc";
import { useCaptureScale } from "./captureScale";
import { ModeButton, ResolutionSlider } from "./DesktopViewerControls";
import { DesktopStream, DetailStream, OverviewStream } from "./DesktopViewerStreams";
import {
  captureCropApplied,
  clearOverviewReady,
  markOverviewReady,
  setCaptureCrop,
  useCaptureCrop,
} from "./captureCrop";
import { setZoomMode, useZoomMode } from "./zoomMode";
import { setOverviewLayer, useOverviewLayer } from "./overviewLayer";

/** The coarse stream only has to fill gaps and be panned over; it is not what is read. */
const OVERVIEW_FPS = 8;
import { TileViewport, type ViewportGestureTelemetry } from "./TileViewport";
import { DesktopKeyboardChrome } from "./DesktopKeyboardChrome";
import { useDesktopKeyboard } from "./useDesktopKeyboard";

const ABSOLUTE_POINTER_KEY = "agentdesk.desktop.absolutePointer";
/**
 * How long the resolution knob has to sit still before the stream is asked to change.
 *
 * A range input reports every step it passes through, and each distinct value renegotiates the
 * connection and replaces the encoder behind it. Dragging from one end to the other would otherwise
 * spawn and retire a capture per step, which is both wasteful and the surest way to provoke the
 * teardown race. The label still follows the thumb; only the request waits.
 */

/** The whole Mac desktop, with no window inventory or Desktop Park controls. */
export function DesktopViewerSurface({
  transport, displayId, interactive = true, navigation, onChromeHeight,
  onSource, onTransport, onEvent, onFirstFrame, onKeyboard, onState, onDisplayUnavailable,
}: {
  transport: AgentHttpTransport;
  displayId?: string;
  interactive?: boolean;
  navigation?: ReactNode;
  onChromeHeight?: (height: number) => void;
  onSource?: (source: WebrtcTileSourceMetadata) => void;
  onTransport?: (transport: DesktopControlTransport | null) => void;
  onEvent?: (event: DesktopControlEvent) => void;
  onFirstFrame?: () => void;
  onDisplayUnavailable?: (replacementDisplayId: string) => void;
  onKeyboard?: (shown: boolean) => void;
  onState?: (state: DesktopStreamState) => void;
}) {
  const [source, setSource] = useState<WebrtcTileSourceMetadata | null>(null);
  const [tile, setTile] = useState<DesktopStreamState>({ kind: "connecting" });
  const [controlTransport, setControlTransport] = useState<DesktopControlTransport | null>(null);
  const [pointerMode, setPointerMode] = useState(true);
  // Mouse only. A finger has no position to honour between taps, so touch keeps the relative
  // trackpad path regardless of this; it decides what a MOUSE does, and defaults to following.
  const [absolutePointer, setAbsolutePointer] = useState(() => {
    try {
      return localStorage.getItem(ABSOLUTE_POINTER_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const toggleAbsolutePointer = useCallback(() => {
    setAbsolutePointer((current) => {
      const next = !current;
      try {
        localStorage.setItem(ABSOLUTE_POINTER_KEY, String(next));
      } catch {
        // a private window still gets the choice for this session
      }
      return next;
    });
  }, []);
  const chromeRef = useRef<HTMLDivElement>(null);
  // The dock's own height, kept here as well as reported upward, because the video box ends above
  // it: the monitor switcher and controls sit BESIDE the picture rather than on top of it, so the
  // bottom of the remote desktop (its own Dock, most visibly) is never covered by our chrome.
  const [chromeHeight, setChromeHeight] = useState(0);
  useLayoutEffect(() => {
    const chrome = chromeRef.current;
    if (!chrome) return;
    // Observe the entire dock: monitor rows, errors, wrapping, and safe-area padding.
    const measure = () => {
      const height = Math.ceil(chrome.getBoundingClientRect().height);
      setChromeHeight(height);
      onChromeHeight?.(height);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(chrome);
    return () => observer.disconnect();
  }, [onChromeHeight]);
  const applyTileState = useCallback((state: DesktopStreamState) => { setTile(state); onState?.(state); }, [onState]);
  const cursorListeners = useRef(new Set<(event: WebrtcCursorEvent) => void>());
  const latestCursorEvents = useRef(new Map<WebrtcCursorEvent["type"], WebrtcCursorEvent>());

  const reportKeyboardTelemetry = useCallback((event: { phase: string; detail: Record<string, unknown> }) => {
    postTileTelemetry("display", {
      attempt: crypto.randomUUID(),
      phase: event.phase,
      detail: JSON.stringify(event.detail),
      elapsedMs: 0,
    }, transport);
  }, [transport]);
  const compatibleControlTransport = source?.desktopControlVersion === 2 && interactive ? controlTransport : null;
  // Read at tap time rather than tracked in state: the shape changes with every hover on the Mac,
  // and nothing on this surface should re-render for a value only the keyboard's prime consults.
  const cursorKind = useCallback((): DesktopCursorKind => {
    const latest = latestCursorEvents.current.get("cursor-image");
    return latest?.type === "cursor-image" ? latest.cursorKind : "unknown";
  }, []);
  const keyboard = useDesktopKeyboard({
    transport: compatibleControlTransport,
    cursorKind,
    report: reportKeyboardTelemetry,
  });
  useEffect(() => { onKeyboard?.(keyboard.keyboardPresented); }, [keyboard.keyboardPresented, onKeyboard]);
  useEffect(() => { onTransport?.(controlTransport); }, [controlTransport, onTransport]);
  const sendPointerInput = useCallback(
    (input: Parameters<DesktopControlTransport["send"]>[0]) => (
      interactive && source !== null && keyboard.sendControl(input)
    ),
    [interactive, keyboard.sendControl, source],
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
    onEvent?.(event);
  }, [keyboard.handleControlEvent, onEvent]);
  const subscribeCursorEvents = useCallback((listener: (event: WebrtcCursorEvent) => void) => {
    cursorListeners.current.add(listener);
    for (const event of latestCursorEvents.current.values()) listener(event);
    return () => cursorListeners.current.delete(listener);
  }, []);
  const applySourceMetadata = useCallback((metadata: WebrtcTileSourceMetadata) => {
    onSource?.(metadata);
    setSource((current) => {
      if (
        current
        && current.width === metadata.width
        && current.height === metadata.height
        && current.displayId === metadata.displayId
        && current.desktopControlVersion === metadata.desktopControlVersion
        && current.desktopNavigationVersion === metadata.desktopNavigationVersion
      ) return current;
      latestCursorEvents.current.clear();
      return metadata;
    });
  }, [onSource]);
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
  const zoomMode = useZoomMode();
  const overviewLayer = useOverviewLayer();
  const twoStreams = zoomMode === "crop" && overviewLayer;
  // A plan is a rectangle on one particular desktop. Carrying it to another display would open the
  // new one zoomed into coordinates that mean nothing there, so a switch starts whole again. The
  // same holds for changing zoom model or layering: each expects to start from one whole stream.
  useEffect(() => {
    setCaptureCrop(null);
    clearOverviewReady();
    return () => {
      setCaptureCrop(null);
      clearOverviewReady();
    };
  }, [displayId, zoomMode, overviewLayer]);
  return (
    <main className="relative h-full overflow-hidden bg-black text-white">
      {/*
        The video's own box, so it can end above the keyboard rather than run full height under it.
        Shortening it is only half the answer: `object-contain` would re-centre the picture in the
        strip and spend most of it on black. The viewport covers the strip and aims it at the remote
        cursor for as long as the keyboard occludes this box.
      */}
      <div data-testid="desktop-video-box" className="absolute inset-x-0 top-0"
        style={{ bottom: Math.max(keyboard.occludedBottom, chromeHeight) }}>
        <TileViewport
          className="size-full"
          pointerMode={pointerMode && source !== null}
          absolutePointer={absolutePointer}
          sendPointerInput={sendPointerInput}
          keyboardPresented={keyboard.keyboardPresented}
          onPointerGestureStart={keyboard.consumePointerGesture}
          onBeforeRemoteClick={keyboard.beforeRemoteClick}
          onGestureTelemetry={reportGestureTelemetry}
          sourceWidth={source?.width}
          sourceHeight={source?.height}
          initialCursor={source?.cursor}
          subscribeCursorEvents={subscribeCursorEvents}
          underlay={twoStreams ? (
            // The coarse whole display. It owns input and the cursor, and it is what the chrome
            // reports on, because it is the stream that is always there.
            <OverviewStream
              windowID="display"
              displayId={displayId}
              fill
              fps={OVERVIEW_FPS}
              httpTransport={transport}
              onState={applyTileState}
              onControlTransport={setControlTransport}
              onControlEvent={publishControlEvent}
              onSourceMetadata={applySourceMetadata}
              onFirstFrame={() => {
                markOverviewReady();
                onFirstFrame?.();
              }}
              onDisplayUnavailable={onDisplayUnavailable}
            />
          ) : undefined}
        >
          {twoStreams ? (
            // The sharp crop, present only while the view wants more than the overview has.
            <DetailStream windowID="display" displayId={displayId} fill httpTransport={transport} />
          ) : (
            <DesktopStream
              windowID="display"
              displayId={displayId}
              fill
              httpTransport={transport}
              onState={applyTileState}
              onControlTransport={setControlTransport}
              onControlEvent={publishControlEvent}
              onSourceMetadata={applySourceMetadata}
              onFirstFrame={onFirstFrame}
              onDisplayUnavailable={onDisplayUnavailable}
            />
          )}
        </TileViewport>
      </div>

      <div ref={chromeRef} data-testid="desktop-bottom-chrome"
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col
          ${keyboard.keyboardPresented ? "" : "gap-1 px-2 pt-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]"}`}>
        {navigation}
        <div role="group" aria-label="Desktop input controls"
          style={interactive && !keyboard.keyboardPresented ? undefined : { display: "none" }}
          className="pointer-events-auto flex flex-wrap items-center justify-end gap-x-1 gap-y-1 rounded-lg bg-black/60 p-1">
          <DesktopKeyboardChrome
            captureRef={keyboard.captureRef}
            accessoryRef={keyboard.accessoryRef}
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
            onPasteToMac={() => { void keyboard.pasteFromClipboard(); }}
            onDeckCharacter={keyboard.sendDeckCharacter}
            onDeckCursorDelta={keyboard.sendDeckCursorDelta}
            onDeckBackspace={keyboard.deckBackspace}
            draft={keyboard.draft}
            onSendDraft={keyboard.sendDraft}
            onCancelDraft={keyboard.cancelDraft}
            showsDeck={keyboard.showsDeck}
            deckAvailable={keyboard.deckAvailable}
            onKeyboardMode={keyboard.setKeyboardMode}
          />
          {!keyboard.keyboardPresented ? (
            <>
              <ResolutionSlider sourceWidth={source?.width} sourceHeight={source?.height} />
              {/* The two zoom models side by side, so they can be compared on the same desk:
                  CSS magnifies the whole-display picture, Crop re-aims the capture at what is
                  being looked at. */}
              <ModeButton
                active={zoomMode === "crop"}
                label={zoomMode === "crop" ? "Crop zoom" : "CSS zoom"}
                icon={<Crop className="size-3.5" aria-hidden />}
                onClick={() => setZoomMode(zoomMode === "crop" ? "css" : "crop")}
              />
              {zoomMode === "crop" ? (
                // The coarse layer under the crop, switchable so its second stream's cost can be
                // measured against the bare edge it removes.
                <ModeButton
                  active={overviewLayer}
                  label={overviewLayer ? "Overview on" : "Overview off"}
                  icon={<Layers className="size-3.5" aria-hidden />}
                  onClick={() => setOverviewLayer(!overviewLayer)}
                />
              ) : null}
              <ModeButton
                active={!pointerMode}
                label="View"
                icon={<Hand className="size-3.5" aria-hidden />}
                onClick={() => setPointerMode(false)}
              />
              <ModeButton
                active={absolutePointer}
                disabled={!pointerReady}
                label={absolutePointer ? "Follow" : "Trackpad"}
                icon={<Crosshair className="size-3.5" aria-hidden />}
                onClick={toggleAbsolutePointer}
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
        <p aria-label="Desktop stream status"
          style={interactive && !keyboard.keyboardPresented ? undefined : { display: "none" }}
          className="truncate px-1 font-mono text-[10px] leading-3 text-white/70">
          {tile.kind === "playing" && source
            ? `${source.width}×${source.height} · ${tile.codec}`
            : tile.kind}
        </p>
      </div>
    </main>
  );
}
