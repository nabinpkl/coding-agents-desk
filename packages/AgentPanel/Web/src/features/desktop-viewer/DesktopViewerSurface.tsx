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
import { getCaptureScale, setCaptureScale, useCaptureScale } from "./captureScale";
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
const CAPTURE_SCALE_SETTLE_MS = 400;

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

/** Best-effort readout of what the current knob asks the encoder for, capped at source-native. */
function encodedCaptureSize(sourceWidth: number, sourceHeight: number, scale: number): string {
  const capped = Math.min(1, scale);
  return `${Math.round(sourceWidth * capped)}×${Math.round(sourceHeight * capped)}`;
}

/**
 * The stream, subscribed to the capture multiplier and the capture plan.
 *
 * This exists so the subscriptions live BELOW the viewport rather than above it. Reading either
 * value in the surface would re-render the surface, which rebuilds the element handed to
 * `TileViewport` as `children` and disturbs the effect holding its view and cursor. Here, a
 * resolution or plan change re-renders this component alone and the view around it does not move.
 * That matters more for the plan than for the multiplier, because the plan is produced by that
 * very effect: routing it upwards would let each settled zoom reset the view it came from.
 */
function DesktopStream(
  props: Omit<Parameters<typeof TileStreamRtc>[0], "captureScale" | "capturePlan">,
) {
  const { onFirstFrame, ...rest } = props;
  return (
    <TileStreamRtc
      {...rest}
      captureScale={useCaptureScale()}
      capturePlan={useCaptureCrop()}
      // The stream is what knows when a requested plan became visible, and the viewport is what
      // has to start placing the frame by that plan's region at that instant. Announcing it here
      // keeps those two from having to know about each other.
      onFirstFrame={() => {
        captureCropApplied();
        onFirstFrame?.();
      }}
    />
  );
}

/** The coarse whole-display stream: no plan, ever, and the ordinary control owner. */
function OverviewStream(
  props: Omit<Parameters<typeof TileStreamRtc>[0], "captureScale" | "capturePlan" | "control">,
) {
  // Viewport-sized, as DeskZoom's overview is its window's backing size: the resolution knob is
  // for a single stream. Applied here it sent a phone a 3858-wide overview beside the sharp
  // stream, and the link dropped both.
  return <TileStreamRtc {...props} captureScale={1} capturePlan={null} />;
}

/**
 * The sharp cropped stream: the store's plan, mounted only while there is one, and never the
 * control owner, since the overview beneath it already is. Its first frame is the swap signal.
 */
function DetailStream(
  props: Pick<Parameters<typeof TileStreamRtc>[0], "windowID" | "displayId" | "fill" | "httpTransport">,
) {
  const plan = useCaptureCrop();
  // Both hooks before the early return: a hook that runs only once a plan exists changes the
  // hook count between renders, and React answers that by unmounting the whole tree to white.
  const captureScale = useCaptureScale();
  if (!plan) return null;
  return (
    <TileStreamRtc
      {...props}
      captureScale={captureScale}
      capturePlan={plan}
      control={false}
      onFirstFrame={captureCropApplied}
    />
  );
}

function ResolutionSlider({
  sourceWidth,
  sourceHeight,
}: {
  sourceWidth?: number;
  sourceHeight?: number;
}) {
  // The slider owns the value while it is being moved, and reports only where it came to rest.
  //
  // Lifting every intermediate step re-rendered the whole viewer -- video element included -- once
  // per step, and a controlled range whose parent re-renders that heavily loses the race with the
  // pointer: React writes a now-stale value back into the DOM mid-drag and the thumb snaps, usually
  // toward whichever end the drag was heading for. Keeping the drag local means one cheap re-render
  // per step here, and one renegotiation when it settles.
  // Seeded from the store and owned here while it moves; the store hears only where it came to
  // rest. Deliberately not subscribed: this control is the one writing, and re-rendering it from
  // its own write would fight the pointer mid-drag.
  const [draft, setDraft] = useState(getCaptureScale);
  useEffect(() => {
    if (draft === getCaptureScale()) return;
    const settle = setTimeout(() => setCaptureScale(draft), CAPTURE_SCALE_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [draft]);
  const encoded = sourceWidth && sourceHeight
    ? encodedCaptureSize(sourceWidth, sourceHeight, draft)
    : null;
  return (
    // Deliberately not a <label> wrapping the input. A label forwards a press anywhere inside it to
    // the control, so pressing the word or the readout dispatched a click on the range -- and the
    // readout sits at the right end, so it landed on the maximum every time.
    <div
      className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-white/75"
      title={encoded ? `Capture resolution ${encoded} (${draft.toFixed(2)}×)` : "Capture resolution"}
    >
      <span aria-hidden className="text-white/60">Res</span>
      <input
        type="range"
        min={CAPTURE_SCALE_MIN}
        max={CAPTURE_SCALE_MAX}
        step={0.25}
        value={draft}
        onChange={(event) => setDraft(Number.parseFloat(event.target.value))}
        aria-label="Capture resolution"
        aria-valuetext={encoded ? `${encoded}, ${draft.toFixed(2)} times` : `${draft.toFixed(2)} times`}
        // `appearance-none` also removes the thumb, so it is drawn back explicitly -- without it
        // there is no grab target and the only way to change the value is to click the track.
        className="h-1 w-32 cursor-pointer appearance-none rounded-full bg-white/25 outline-none
          focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white
          [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
          [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white"
      />
      <span className="w-9 tabular-nums text-right text-white/60">{draft.toFixed(2)}×</span>
    </div>
  );
}
