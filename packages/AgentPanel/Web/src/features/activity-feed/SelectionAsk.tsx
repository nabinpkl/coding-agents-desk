"use client";

// Asking about a passage: select any text in a transcript, and a button beside the selection
// starts a fork of the session whose job is to answer a question about it.
//
// Above the input paths on purpose. A mouse drag and a phone's long press both end in a document
// selection, and `selectionchange` reports both, so one model serves the Mac and the iPhone. The
// mouse gets one adapter: the button waits for the drag to end rather than chasing the pointer.
// On the phone the button sits below the selection, because the phone's own Copy menu sits above.

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageCircleQuestion } from "lucide-react";
import { useEventListener } from "@/hooks/dom/useEventListener";
import { useOverlayPlacement } from "@/hooks/dom/overlays";

/** The gap between the selection and the button, wide enough to clear the phone's end handle. */
const GAP = 14;
/** The gap the button keeps from the edge of the window. */
const MARGIN = 8;

interface Placement {
  top: number;
  left: number;
}

/**
 * Below the selection's last line, at its end, or above its first line when there is no room
 * below, and inside the box's lower edge when there is room for neither. Null when the selection has scrolled out of the box it was made in, so the button never
 * floats over the composer or a neighbouring card.
 */
export function placeAskButton(lines: readonly DOMRect[], box: DOMRect, button: DOMRect): Placement | null {
  const first = lines[0];
  const last = lines.at(-1);
  if (!first || !last) return null;
  if (last.bottom < box.top || first.top > box.bottom) return null;
  const viewportWidth = globalThis.innerWidth || 0;
  const below = last.bottom + GAP;
  const above = first.top - GAP - button.height;
  const top =
    below + button.height <= box.bottom
      ? below
      : above >= box.top
        ? above
        : // A selection taller than the box: inside its lower edge, over the text.
          box.bottom - MARGIN - button.height;
  const left = last.right - button.width / 2;
  return { top, left: Math.max(MARGIN, Math.min(left, viewportWidth - MARGIN - button.width)) };
}

/** The text selected inside `box`, and the range it spans; null for nothing, or for text elsewhere. */
function readSelection(box: HTMLElement): { quote: string; range: Range } | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!box.contains(range.commonAncestorContainer)) return null;
  const quote = selection.toString().trim();
  return quote ? { quote, range } : null;
}

export function SelectionAsk({
  within,
  onAsk,
}: {
  /** The transcript's box: only a selection inside it is asked about. Null while it mounts. */
  within: HTMLElement | null;
  /** Starts the fork, with the selected text. */
  onAsk: (quote: string) => void;
}) {
  const [selected, setSelected] = useState<{ quote: string; range: Range } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  /**
   * Set while the button itself is pressed. A tap on the phone can clear the selection before the
   * tap's click arrives, and the button must still be there to take it; the passage was read when
   * it was selected, so nothing is lost by the selection going.
   */
  const pressing = useRef(false);

  const read = () => {
    if (!within) return;
    const next = readSelection(within);
    if (next === null && pressing.current) return;
    setSelected(next);
  };
  const target = within ? document : null;
  useEventListener(target, "selectionchange", read);
  useEventListener<PointerEvent>(target, "pointerdown", (event) => {
    if (button.current?.contains(event.target as Node)) return;
    pressing.current = false;
    if (event.pointerType === "mouse") setDragging(true);
  });
  useEventListener<PointerEvent>(target, "pointerup", (event) => {
    if (event.pointerType !== "mouse") return;
    setDragging(false);
    read();
  });

  const shown = selected !== null && !dragging;
  useOverlayPlacement(shown, () => {
    const node = button.current;
    if (!selected || !within || !node) return;
    // Asked of the range each time: it is live, so after a scroll it answers where the text is now.
    const lines = Array.from(selected.range.getClientRects());
    setPlacement(placeAskButton(lines, within.getBoundingClientRect(), node.getBoundingClientRect()));
  }, [selected, within]);

  if (!shown) return null;
  const ask = () => {
    pressing.current = false;
    onAsk(selected.quote);
    document.getSelection()?.removeAllRanges();
    setSelected(null);
  };
  return createPortal(
    <button
      ref={button}
      type="button"
      data-portal-menu=""
      // Kept from taking focus or ending the selection on a mouse press, so the passage stays lit
      // until the fork opens.
      onPointerDown={(event) => {
        event.preventDefault();
        pressing.current = true;
      }}
      onPointerCancel={() => {
        pressing.current = false;
      }}
      onClick={ask}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        document.getSelection()?.removeAllRanges();
        setSelected(null);
      }}
      title="Ask a fork of this session about the selected text"
      style={{
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        visibility: placement ? undefined : "hidden",
      }}
      className="fixed z-50 flex h-9 items-center gap-1.5 rounded-full border border-border bg-popover px-3.5 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-popover-foreground shadow-lg outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary active:bg-muted"
    >
      <MessageCircleQuestion className="size-4 shrink-0 text-primary" aria-hidden />
      Ask about this
    </button>,
    document.body,
  );
}
