"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  DesktopControlEvent,
  DesktopCursorKind,
  WebrtcCursorEvent,
  WebrtcTileSourceMetadata,
} from "@agentdesk/agent-feed-wire";
import { Crosshair, Hand, MousePointer2, Touchpad } from "lucide-react";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";
import type { DesktopStreamState } from "@/features/desktop-viewer/DesktopStreamState";
import {
  postTileTelemetry,
  type DesktopControlTransport,
} from "@/features/desktop-viewer/tile-stream/TileStreamRtc";
import { ModeButton } from "@/features/desktop-viewer/DesktopViewerControls";
import { DesktopViewerSettings } from "@/features/desktop-viewer/DesktopViewerSettings";
import { DesktopStream, DetailStream, OverviewStream } from "@/features/desktop-viewer/DesktopViewerStreams";
import {
  clearOverviewReady,
  markOverviewReady,
  setCaptureCrop,
} from "@/features/desktop-viewer/zoom/captureCrop";
import { useZoomMode } from "@/features/desktop-viewer/zoom/zoomMode";
import { useOverviewLayer } from "@/features/desktop-viewer/zoom/overviewLayer";

/** The coarse stream only has to fill gaps and be panned over; it is not what is read. */
const OVERVIEW_FPS = 8;
import { TileViewport, type ViewportGestureTelemetry } from "@/features/desktop-viewer/tile-viewport/TileViewport";
import { DesktopKeyboardChrome } from "@/features/desktop-viewer/keyboard-input/DesktopKeyboardChrome";
import { useDesktopKeyboard } from "@/features/desktop-viewer/keyboard-input/useDesktopKeyboard";
import { usePointerInputSession } from "@/features/desktop-viewer/pointer-input/pointerInputSession";
import { TrackpadDeck } from "@/features/desktop-viewer/trackpad/TrackpadDeck";
import { useDeckHeight } from "@/features/desktop-viewer/trackpad/deckHeightPreference";
import {
  primaryPointerIsTouch,
  storeTrackpadDeck,
  storedTrackpadDeck,
  trackpadDeckHeight,
} from "@/features/desktop-viewer/trackpad/trackpadConstants";

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
  // What a finger on the picture does, as the iPhone client's layouts had it. Pointer: the picture
  // is the pointer's surface. Trackpad: the deck under the picture drives the pointer and the
  // picture is only looked at, panned and zoomed ("As Is"). View: nothing reaches the Mac.
  // Trackpad is only offered to a touch device, so only a touch device can come back to it.
  const [pictureMode, setPictureMode] = useState<"view" | "trackpad" | "pointer">(
    () => (primaryPointerIsTouch() && storedTrackpadDeck() ? "trackpad" : "pointer"),
  );
  const pointerMode = pictureMode === "pointer";
  const choosePictureMode = useCallback((next: "view" | "trackpad" | "pointer") => {
    setPictureMode(next);
    // Remembered as the choice between the two ways of driving the pointer; View is a glance.
    if (next !== "view") storeTrackpadDeck(next === "trackpad");
  }, []);
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
  // One pointer for the whole viewer: the picture and the trackpad deck both drive it.
  const pointerInput = usePointerInputSession(sendPointerInput);
  // The deck is a touch device's: a mouse already points at the picture itself (Follow).
  const [touchDevice] = useState(primaryPointerIsTouch);
  const mainRef = useRef<HTMLElement>(null);
  const [viewerHeight, setViewerHeight] = useState(0);
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const measure = () => setViewerHeight(main.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    return () => observer.disconnect();
  }, []);
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
  // Typing takes the bottom of the screen for the keyboard; the deck gives it back.
  const deckShown = touchDevice && pictureMode === "trackpad" && interactive && !keyboard.keyboardPresented;
  const deckShare = useDeckHeight((state) => state.deckShare);
  const deckHeight = deckShown ? trackpadDeckHeight(viewerHeight, deckShare) : 0;
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
    <main ref={mainRef} className="relative h-full overflow-hidden bg-black text-white">
      {/*
        The video's own box, so it can end above the keyboard rather than run full height under it.
        Shortening it is only half the answer: `object-contain` would re-centre the picture in the
        strip and spend most of it on black. The viewport covers the strip and aims it at the remote
        cursor for as long as the keyboard occludes this box.
      */}
      <div data-testid="desktop-video-box" className="absolute inset-x-0 top-0"
        style={{ bottom: Math.max(keyboard.occludedBottom, chromeHeight + deckHeight) }}>
        <TileViewport
          className="size-full"
          pointerMode={pointerMode && source !== null}
          showCursor={pictureMode === "trackpad"}
          absolutePointer={absolutePointer}
          input={pointerInput}
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

      {deckShown ? (
        <div className="absolute inset-x-0 z-20" style={{ bottom: chromeHeight }}>
          <TrackpadDeck
            input={pointerInput}
            height={deckHeight}
            disabled={!pointerReady}
            beforeClick={keyboard.beforeRemoteClick}
          />
        </div>
      ) : null}

      <div ref={chromeRef} data-testid="desktop-bottom-chrome"
        className={`pointer-events-none absolute inset-x-0 bottom-0 z-30 flex flex-col
          ${keyboard.keyboardPresented ? "" : "gap-1 px-2 pt-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]"}`}>
        {navigation}
        <div role="group" aria-label="Desktop input controls"
          style={interactive && !keyboard.keyboardPresented ? undefined : { display: "none" }}
          className="@container pointer-events-auto flex flex-nowrap items-center justify-between gap-1 rounded-lg bg-black/60 p-1">
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
              {/* What a finger on the picture does: one choice, so one segmented group. */}
              <div role="group" aria-label="Picture mode" className="flex min-w-0 items-center gap-0.5">
                <ModeButton
                  active={pictureMode === "view"}
                  label="View"
                  icon={<Hand className="size-3.5" aria-hidden />}
                  onClick={() => choosePictureMode("view")}
                />
                {touchDevice ? (
                  // Follow decides what a MOUSE does, which a finger never reaches; on a touch
                  // device this slot is the trackpad mode instead.
                  <ModeButton
                    active={pictureMode === "trackpad"}
                    disabled={!pointerReady}
                    label="Trackpad"
                    icon={<Touchpad className="size-3.5" aria-hidden />}
                    onClick={() => choosePictureMode("trackpad")}
                  />
                ) : (
                  <ModeButton
                    active={absolutePointer}
                    disabled={!pointerReady}
                    label={absolutePointer ? "Follow" : "Trackpad"}
                    icon={<Crosshair className="size-3.5" aria-hidden />}
                    onClick={toggleAbsolutePointer}
                  />
                )}
                <ModeButton
                  active={pointerMode}
                  disabled={!pointerReady}
                  label="Pointer"
                  icon={<MousePointer2 className="size-3.5" aria-hidden />}
                  onClick={() => choosePictureMode("pointer")}
                />
              </div>
              <DesktopViewerSettings
                status={tile.kind === "playing" && source ? `${source.width}×${source.height} · ${tile.codec}` : tile.kind}
                attention={controlMismatch
                  ? `Control v${source.desktopControlVersion || "unknown"} unsupported`
                  : pointerReady ? null : "Input connecting"}
                sourceWidth={source?.width}
                sourceHeight={source?.height}
                autoKeyboard={keyboard.autoKeyboard}
                onAutoKeyboardChange={keyboard.setAutoKeyboard}
                navigation={navigation != null}
                hidden={!interactive || keyboard.keyboardPresented}
              />
            </>
          ) : null}
        </div>
      </div>
    </main>
  );
}
