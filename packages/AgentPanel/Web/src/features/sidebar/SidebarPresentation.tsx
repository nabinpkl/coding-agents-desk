import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
} from "@/features/sidebar/sidebarPreferences";

const COMPACT_SIDEBAR_QUERY = "(max-width: 719px)";
const HOVER_SIDEBAR_QUERY = "(hover: hover) and (pointer: fine)";

function useMediaQuery(queryText: string): boolean {
  const [matches, setMatches] = useState(() =>
    globalThis.matchMedia?.(queryText).matches ?? false,
  );

  useEffect(() => {
    const query = globalThis.matchMedia?.(queryText);
    if (!query) return undefined;
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [queryText]);

  return matches;
}

export function useSidebarEnvironment(): {
  compact: boolean;
  hoverCapable: boolean;
} {
  return {
    compact: useMediaQuery(COMPACT_SIDEBAR_QUERY),
    hoverCapable: useMediaQuery(HOVER_SIDEBAR_QUERY),
  };
}

export function ResizableSidebar({
  width,
  onWidthChange,
  onWidthCommit,
  children,
}: {
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  children: ReactNode;
}) {
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const latestWidth = useRef(width);

  useEffect(() => {
    latestWidth.current = width;
  }, [width]);

  const previewWidth = (nextWidth: number) => {
    const clamped = clampSidebarWidth(nextWidth);
    latestWidth.current = clamped;
    onWidthChange(clamped);
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onWidthCommit(latestWidth.current);
  };

  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = width - 16;
    else if (event.key === "ArrowRight") nextWidth = width + 16;
    else if (event.key === "Home") nextWidth = MIN_SIDEBAR_WIDTH;
    else if (event.key === "End") nextWidth = MAX_SIDEBAR_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    const clamped = clampSidebarWidth(nextWidth);
    previewWidth(clamped);
    onWidthCommit(clamped);
  };

  return (
    <aside
      aria-label="Agent navigation"
      className="relative h-full shrink-0 border-r border-border"
      style={{ width }}
    >
      {children}
      <div
        role="separator"
        aria-label="Resize agent sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels`}
        tabIndex={0}
        className="group absolute inset-y-0 right-0 z-30 w-3 translate-x-1/2 cursor-col-resize touch-none outline-none"
        onPointerDown={(event) => {
          event.preventDefault();
          drag.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: width,
          };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const activeDrag = drag.current;
          if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
          previewWidth(activeDrag.startWidth + event.clientX - activeDrag.startX);
        }}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onKeyDown={resizeFromKeyboard}
      >
        <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-primary/45 group-focus-visible:w-0.5 group-focus-visible:bg-primary" />
      </div>
    </aside>
  );
}

export function HoverSidebarPreview({
  width,
  onPointerEnter,
  onPointerLeave,
  onDismiss,
  children,
}: {
  width: number;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label="Agent navigation preview"
      className="absolute top-11 bottom-0 left-0 z-40 border-r border-border bg-card shadow-2xl"
      // The stored width is what the sidebar wants when it is pinned beside content. As a
      // transient overlay it also has to leave enough of the thread showing to read as a layer
      // over the panel rather than a replacement of it, which a 420px preference does not do in a
      // 480pt Agents window. The cap only ever binds in a window too narrow to pin in.
      style={{ width, maxWidth: "calc(100% - 3.5rem)" }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocus={onPointerEnter}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        // A row menu is portalled to the body, because a menu rendered inside a card is clipped by
        // it. So focus moving into one leaves this element in the DOM while never leaving the
        // sidebar as the reader experiences it, and dismissing here would close the whole preview
        // the instant a ⋮ inside it was opened.
        if (event.relatedTarget?.closest("[data-portal-menu]")) return;
        onPointerLeave();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onDismiss();
      }}
    >
      {children}
    </aside>
  );
}
