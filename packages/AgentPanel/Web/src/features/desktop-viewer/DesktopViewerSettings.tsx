"use client";

// The viewer's one settings button and the popover it opens: everything a reader sets once and
// leaves, so the bar under the picture keeps only what is pressed while working (the keyboard and
// what a finger on the picture does) and fits one row on a phone.
//
// It holds the desktops row's setting too, which used to sit behind a second gear on that row.
//
// Positioned inside the dock rather than portalled: the dock is the viewer's top layer and the
// popover opens upward into the viewer, so no ancestor between them clips it, and it hides with
// the dock when the keyboard takes the bottom of the screen.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { ResolutionSlider } from "@/features/desktop-viewer/DesktopViewerControls";
import { useMacSwipeDirection } from "@/features/desktop-viewer/navigation/macSwipeDirection";
import { setOverviewLayer, useOverviewLayer } from "@/features/desktop-viewer/zoom/overviewLayer";
import { setZoomMode, useZoomMode } from "@/features/desktop-viewer/zoom/zoomMode";

const focusRing = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white";

export function DesktopViewerSettings({
  status,
  attention,
  sourceWidth,
  sourceHeight,
  autoKeyboard,
  onAutoKeyboardChange,
  navigation,
  hidden,
}: {
  /** What the stream is doing, e.g. `1920×1080 · webrtc/h265`. */
  status: string;
  /** Something the reader has to know about, shown on the button and atop the popover. */
  attention: string | null;
  sourceWidth?: number;
  sourceHeight?: number;
  autoKeyboard: boolean;
  onAutoKeyboardChange: (auto: boolean) => void;
  /** Whether this desktop has the desktops row, whose swipe direction is set here. */
  navigation: boolean;
  /** The dock is hidden, so the popover closes with it rather than coming back open. */
  hidden: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const zoomMode = useZoomMode();
  const overviewLayer = useOverviewLayer();
  const macDirection = useMacSwipeDirection((state) => state.macDirection);
  const setMacDirection = useMacSwipeDirection((state) => state.setMacDirection);

  useEffect(() => { if (hidden) setOpen(false); }, [hidden]);
  useEffect(() => {
    if (!open) return;
    // `composedPath`, not `contains`: a control inside that removes itself on press (the Overview
    // row does when Crop is turned off) is already detached by the time this runs.
    const outside = (event: PointerEvent) => {
      if (root.current && !event.composedPath().includes(root.current)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        aria-label="Viewer settings"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={attention ?? "Viewer settings"}
        onClick={() => setOpen(!open)}
        className={`relative flex size-8 items-center justify-center rounded-md transition-colors ${focusRing}
          motion-reduce:transition-none
          ${open ? "bg-white text-black" : "text-white/75 hover:bg-white/10 active:bg-white/15"}`}
      >
        <Settings2 className="size-4" aria-hidden />
        {attention ? <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-amber-400" /> : null}
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Viewer settings"
          className="absolute right-0 bottom-full mb-2 flex w-72 max-w-[calc(100vw-1rem)] flex-col gap-2 rounded-xl
            border border-white/15 bg-neutral-950/95 p-3 text-[11px] text-white shadow-lg"
        >
          <p aria-label="Desktop stream status" className="truncate font-mono text-[10px] text-white/70">{status}</p>
          {attention ? <p role="status" className="text-amber-300">{attention}</p> : null}
          <ResolutionSlider sourceWidth={sourceWidth} sourceHeight={sourceHeight} />
          {/* The two zoom models side by side, so they can be compared on the same desk: CSS
              magnifies the whole-display picture, Crop re-aims the capture at what is being looked at. */}
          <div className="flex items-center gap-2 px-2">
            <span className="w-16 shrink-0 text-white/60">Zoom</span>
            <div role="group" aria-label="Zoom model" className="flex rounded-md bg-white/10 p-0.5">
              {(["css", "crop"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={zoomMode === mode}
                  onClick={() => setZoomMode(mode)}
                  className={`rounded px-2.5 py-1 transition-colors ${focusRing} motion-reduce:transition-none ${
                    zoomMode === mode ? "bg-white text-black" : "text-white/75 hover:bg-white/10 active:bg-white/15"
                  }`}
                >
                  {mode === "css" ? "CSS" : "Crop"}
                </button>
              ))}
            </div>
          </div>
          {zoomMode === "crop" ? (
            // The coarse layer under the crop, switchable so its second stream's cost can be
            // measured against the bare edge it removes.
            <Toggle label="Overview layer" checked={overviewLayer} onChange={setOverviewLayer} />
          ) : null}
          <Toggle label="Auto keyboard" checked={autoKeyboard} onChange={onAutoKeyboardChange} />
          {navigation ? <Toggle label="Mac swipe direction" checked={macDirection} onChange={setMacDirection} /> : null}
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md bg-white px-2.5 py-1.5 text-black transition-colors hover:bg-white/90 active:bg-white/80
                focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white motion-reduce:transition-none"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-h-8 cursor-pointer items-center gap-2 px-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 cursor-pointer accent-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      />
      {label}
    </label>
  );
}
