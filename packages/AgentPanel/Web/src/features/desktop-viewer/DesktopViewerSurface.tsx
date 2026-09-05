"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  DesktopControlEvent,
  DesktopCursorKind,
  WebrtcCursorEvent,
  WebrtcTileSourceMetadata,
} from "@agentdesk/agent-feed-wire";
import { Crosshair, Hand, MousePointer2 } from "lucide-react";
import type { AgentHttpTransport } from "../activity-feed/transport/AgentHttpTransport";
import type { DesktopStreamState } from "./DesktopStreamState";
import {
  CAPTURE_SCALE_MAX,
  CAPTURE_SCALE_MIN,
  postTileTelemetry,
  TileStreamRtc,
  type DesktopControlTransport,
} from "./TileStreamRtc";
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
  captureScale = 1, onCaptureScale,
  onSource, onTransport, onEvent, onFirstFrame, onKeyboard, onState, onDisplayUnavailable,
}: {
  transport: AgentHttpTransport;
  displayId?: string;
  interactive?: boolean;
  navigation?: ReactNode;
  onChromeHeight?: (height: number) => void;
  captureScale?: number;
  onCaptureScale?: (value: number) => void;
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
  // What the stream has actually been asked for, as opposed to where the thumb is right now.
  const [appliedCaptureScale, setAppliedCaptureScale] = useState(captureScale);
  useEffect(() => {
    const settle = setTimeout(() => setAppliedCaptureScale(captureScale), CAPTURE_SCALE_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [captureScale]);
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
        >
          <TileStreamRtc
            windowID="display"
            displayId={displayId}
            fill
            captureScale={appliedCaptureScale}
            httpTransport={transport}
            onState={applyTileState}
            onControlTransport={setControlTransport}
            onControlEvent={publishControlEvent}
            onSourceMetadata={applySourceMetadata}
            onFirstFrame={onFirstFrame}
            onDisplayUnavailable={onDisplayUnavailable}
          />
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
          />
          {!keyboard.keyboardPresented ? (
            <>
              {onCaptureScale ? (
                <ResolutionSlider
                  value={captureScale}
                  onChange={onCaptureScale}
                  encoded={source ? encodedCaptureSize(source.width, source.height, captureScale) : null}
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
            ? `${source.width}×${source.height} · ${captureScale.toFixed(2)}× · ${tile.codec}`
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

function ResolutionSlider({
  value,
  onChange,
  encoded,
}: {
  value: number;
  onChange: (value: number) => void;
  encoded: string | null;
}) {
  return (
    <label
      className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-white/75"
      title={encoded ? `Capture resolution ${encoded} (${value.toFixed(2)}×)` : "Capture resolution"}
    >
      <span className="tabular-nums text-white/60">Res</span>
      <input
        type="range"
        min={CAPTURE_SCALE_MIN}
        max={CAPTURE_SCALE_MAX}
        step={0.25}
        value={value}
        onChange={(event) => onChange(Number.parseFloat(event.target.value))}
        aria-label="Capture resolution"
        aria-valuetext={encoded ? `${encoded}, ${value.toFixed(2)} times` : `${value.toFixed(2)} times`}
        className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-white/25 accent-white
          outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      />
      <span className="w-9 tabular-nums text-right text-white/60">{value.toFixed(2)}×</span>
    </label>
  );
}
