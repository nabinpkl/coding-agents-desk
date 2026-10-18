import { useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { PanelsTopLeft } from "lucide-react";
import type { DesktopDisplay } from "@agentdesk/agent-feed-wire";
import { navigationGeometry, NAVIGATION_TUNING, type NavigationModel } from "@/features/desktop-viewer/navigation/desktopNavigationModel";
import { useMacSwipeDirection } from "@/features/desktop-viewer/navigation/macSwipeDirection";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useResizeObserver } from "@/hooks/dom/useResizeObserver";
import { useNotify } from "@/hooks/useNotify";

const buttonStyle = "touch-none rounded-md text-white enabled:hover:bg-white/15 enabled:active:bg-white/25 focus-visible:outline-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:text-white/35";
function preference(key: string, fallback: boolean): { value: boolean; failed: boolean } {
  try { const value = localStorage.getItem(key); return { value: value === null ? fallback : value === "true", failed: false }; }
  catch { return { value: fallback, failed: true }; }
}

export function DesktopNavigationChrome({
  model, displays, displayId, disabled, hidden, switching, onDisplay, onSelect,
  onBegin, onMove, onEnd, onCancel, onRefresh,
}: {
  model: NavigationModel;
  displays: DesktopDisplay[];
  displayId?: string;
  disabled: boolean;
  hidden: boolean;
  switching: boolean;
  onDisplay: (id: string) => void;
  onSelect: (id: string) => void;
  onBegin: () => string | null;
  onMove: (translation: number, velocity: number, width: number, mac: boolean) => void;
  onEnd: (translation: number, velocity: number, width: number, mac: boolean) => void;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  const [saved] = useState(() => preference("agentdesk.desktop-rail-expanded", true));
  const [expanded, setExpanded] = useState(saved.value);
  // Set from the viewer's settings popover, read here per gesture.
  const macDirection = useMacSwipeDirection((state) => state.macDirection);
  const directionUnsaved = useMacSwipeDirection((state) => state.storageFailed);
  const [expandedUnsaved, setExpandedUnsaved] = useState(saved.failed);
  const storageFailed = expandedUnsaved || directionUnsaved;
  const [width, setWidth] = useState(1);
  const root = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ id: number; startX: number; lastX: number; lastAt: number;
    velocity: number; dragging: boolean; target?: string } | null>(null);
  const activePointers = useRef(new Set<number>());
  const display = displays.find((item) => item.id === displayId);
  const spaces = display?.spaces.filter((space) => space.type === 0) ?? [];
  const activeIndex = spaces.findIndex((space) => space.id === display?.activeSpaceId);
  const target = model.motion.kind === "pending" ? model.motion.target : display?.activeSpaceId;
  const targetIndex = spaces.findIndex((space) => space.id === target);
  const resting = navigationGeometry(spaces.length, width, activeIndex);
  const landing = navigationGeometry(spaces.length, width, targetIndex);
  const geometry = model.motion.kind === "pending" ? landing : resting;
  let offset = geometry.offset;
  if (model.motion.kind === "dragging") {
    const raw = offset - model.motion.translation;
    const clamped = Math.min(geometry.maximum, Math.max(0, raw));
    const overflow = raw - clamped;
    offset = clamped + overflow / (1 + Math.abs(overflow) / Math.max(1, width * 0.3));
  }
  const duration = model.motion.kind === "dragging" ? 0
    : model.motion.kind === "pending" ? model.motion.durationMs : 200;

  const measure = () => setWidth(row.current?.clientWidth ?? 1);
  useDomSync(measure, [expanded, hidden, displays.length, spaces.length]);
  useResizeObserver(row, measure);

  // Going away, or out of reach, ends whatever the fingers were doing.
  useNotify(hidden || disabled, (off) => {
    if (off) { pointer.current = null; activePointers.current.clear(); onCancel(); }
  });

  const remember = (key: string, value: boolean) => {
    try { localStorage.setItem(key, String(value)); }
    catch { setExpandedUnsaved(true); }
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointers.current.add(event.pointerId);
    if (activePointers.current.size !== 1) { onCancel(); pointer.current = null; return; }
    const tile = (event.target as HTMLElement).closest<HTMLElement>("[data-space-id]");
    pointer.current = { id: event.pointerId, startX: event.clientX, lastX: event.clientX,
      lastAt: event.timeStamp, velocity: 0, dragging: false, target: tile?.dataset.spaceId };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    event.preventDefault();
    const dt = event.timeStamp - p.lastAt;
    if (dt > 0) p.velocity = Math.max(-100_000, Math.min(100_000, (event.clientX - p.lastX) * 1000 / dt));
    p.lastX = event.clientX;
    p.lastAt = event.timeStamp;
    const translation = event.clientX - p.startX;
    if (!p.dragging && Math.abs(translation) >= NAVIGATION_TUNING.slop) {
      if (!onBegin()) { pointer.current = null; return; }
      p.dragging = true;
    }
    if (p.dragging) onMove(translation, p.velocity, root.current?.clientWidth ?? width, macDirection);
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    activePointers.current.delete(event.pointerId);
    const p = pointer.current;
    if (!p || p.id !== event.pointerId) return;
    pointer.current = null;
    event.preventDefault();
    if (p.dragging) onEnd(event.clientX - p.startX, event.timeStamp - p.lastAt > 100 ? 0 : p.velocity,
      root.current?.clientWidth ?? width, macDirection);
    else if (p.target) onSelect(p.target);
  };
  const cancel = () => { pointer.current = null; activePointers.current.clear(); onCancel(); };
  const cancelledPointer = (event: PointerEvent<HTMLDivElement>) => {
    activePointers.current.delete(event.pointerId);
    if (pointer.current?.id === event.pointerId) { pointer.current = null; onCancel(); }
  };
  if (hidden) return null;
  return (
    <div ref={root} data-testid="desktop-navigation" className="pointer-events-auto relative select-none text-[12px]">
      {displays.length > 1 ? (
        <div aria-label="Monitors" className="mb-1 flex h-8 gap-2 px-2">
          {displays.map((item) => (
            <button key={item.id} type="button" aria-pressed={item.id === displayId}
              onClick={() => onDisplay(item.id)}
              className={`${buttonStyle} min-w-0 flex-1 truncate border border-white/15 px-2 ${item.id === displayId ? "bg-sky-500/25" : "bg-black/70"}`}>
              {item.label || (item.isMain ? "Main" : "Display")}
            </button>
          ))}
        </div>
      ) : null}
      {display && display.spaces.length > 1 ? (
        <div className={`relative flex overflow-hidden rounded-lg ${expanded ? "bg-neutral-900/95" : ""}`}
          style={{ height: expanded ? 36 : 26 }}>
          <button type="button" aria-label={expanded ? "Hide Desktops" : "Show Desktops"}
            aria-expanded={expanded} className={`${buttonStyle} shrink-0 ${expanded ? "w-6" : "w-full text-white/50"}`}
            onClick={() => {
              cancel();
              setExpanded(!expanded);
              remember("agentdesk.desktop-rail-expanded", !expanded);
              if (!expanded) onRefresh();
            }}>
            <PanelsTopLeft className="ml-0.5 size-4" aria-hidden />
          </button>
          {expanded ? (
            <div ref={row} className="relative my-[3px] min-w-0 flex-1 overflow-hidden touch-none"
              onPointerDown={down} onPointerMove={move} onPointerUp={up}
              onPointerCancel={cancelledPointer} onLostPointerCapture={cancelledPointer}>
              <div className="flex h-[30px] gap-[10px] transition-transform duration-[var(--nav-duration)] ease-in-out motion-reduce:transition-none"
                style={{ paddingLeft: geometry.inset, transform: `translateX(${-offset}px)`,
                  "--nav-duration": `${duration}ms` } as CSSProperties}>
                {spaces.map((space, index) => (
                  <button key={space.id} type="button" data-space-id={space.id} disabled={disabled}
                    aria-label={`Desktop ${index + 1}`} aria-current={space.id === display?.activeSpaceId ? "true" : undefined}
                    onClick={(event) => { if (event.detail === 0) onSelect(space.id); }}
                    className={`${buttonStyle} h-[30px] w-10 shrink-0 bg-neutral-800`}>
                    D{index + 1}
                  </button>
                ))}
              </div>
              {targetIndex >= 0 ? <div aria-hidden className="pointer-events-none absolute top-0 h-[30px] w-10 rounded-md border-[1.5px] border-sky-400 transition-[left] duration-[var(--nav-duration)] ease-in-out motion-reduce:transition-none"
                style={{ left: geometry.indicatorLeft, "--nav-duration": `${duration}ms` } as CSSProperties} /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {(model.error || storageFailed) && !switching ? <div role="status" className="bg-black/90 px-2 text-[10px] text-white/80">
        {model.error || "Navigation preferences cannot be saved"}
      </div> : null}
    </div>
  );
}
