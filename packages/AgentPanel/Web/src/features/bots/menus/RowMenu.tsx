import { EllipsisVertical, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** The gap this menu keeps between itself and the edge of the window. */
const MARGIN = 8;
/** The gap between the trigger and the menu, matching the `mt-1` this used to carry. */
const GAP = 4;

export interface RowMenuItem {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

/** Where an open menu sits, in viewport coordinates, because it is positioned `fixed`. */
interface Placement {
  top: number;
  left: number;
}

/** The overflow values that clip a child, named rather than everything-but-`visible`. */
function clips(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll" || overflow === "hidden";
}

/**
 * Whether the trigger is still inside every ancestor that clips it.
 *
 * The one thing portalling takes away and has to be given back. A menu inside the card was cut off
 * with the card, which was the bug -- but it also disappeared with it. One in `document.body` has
 * no such relationship, so scrolling the trigger under a card header or off the strip leaves the
 * menu floating over content it has nothing to do with. This is the cheap version of what a
 * floating-element library calls `hide`: a rect test per clipping ancestor, run only while a menu
 * is open, on a list that is a handful of nodes deep.
 */
function triggerIsVisible(button: HTMLElement): boolean {
  const rect = button.getBoundingClientRect();
  for (let node = button.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    // `getComputedStyle` answers with an empty string for a property nothing has set in some
    // engines, so this asks for the clipping values by name: treating the empty string as a
    // clipper would make the nearest wrapper a boundary and close every menu on sight.
    if (!clips(style.overflowY) && !clips(style.overflowX)) continue;
    // Strictly outside, so a row resting exactly on a boundary counts as visible. Touching edges
    // are what degenerate rects produce -- a hidden tab, a row mid-measure -- and closing a menu
    // because two zeroes compared equal would be this check inventing its own failure.
    const box = node.getBoundingClientRect();
    if (rect.bottom < box.top || rect.top > box.bottom) return false;
    if (rect.right < box.left || rect.left > box.right) return false;
  }
  return true;
}

/**
 * Where to put an open menu, measured against the WINDOW rather than against anything it is in.
 *
 * Below the trigger and right-aligned to it by default, which is where it has always appeared.
 * Upward when the window has no room below and more above, and clamped on both axes so a trigger
 * at any edge still gets a menu that is entirely on screen.
 */
function placeMenu(trigger: DOMRect, menu: DOMRect): Placement {
  const viewportHeight = globalThis.innerHeight || 0;
  const viewportWidth = globalThis.innerWidth || 0;
  const below = viewportHeight - trigger.bottom - MARGIN;
  const above = trigger.top - MARGIN;
  const upward = menu.height > below && above > below;
  const top = upward ? trigger.top - GAP - menu.height : trigger.bottom + GAP;
  // The clamps are what make "neither side fits" a menu with its top edge on screen rather than a
  // menu with nothing on screen. `Math.max` last, so a menu taller than the window starts at the
  // top instead of being pushed off it.
  return {
    top: Math.max(MARGIN, Math.min(top, viewportHeight - MARGIN - menu.height)),
    left: Math.max(MARGIN, Math.min(trigger.right - menu.width, viewportWidth - MARGIN - menu.width)),
  };
}

/**
 * The actions menu on a row, wherever a row names one thing and offers a short list of things to
 * do to it.
 *
 * The shell rather than the actions: a trigger named for its row, a popup that closes on Escape or
 * a pointer landing outside it, and focus that goes to the first item on open and back to the
 * trigger on close. The Bots sidebar, the canvas roster and the canvas card header all need exactly
 * that and differ only in what the items say, which is why this is one component and not three
 * copies of the same `useEffect`.
 *
 * **The menu is rendered into `document.body`, not into the row.** It used to be an absolutely
 * positioned child, which meant the card decided what it could do: every canvas card sets
 * `overflow-hidden` to keep its own content inside its rounded corners, and a clipped child is cut
 * off at that edge rather than allowed to overflow the page. Choosing a direction -- which is what
 * this did before -- only helps while ONE direction fits. On a card shorter than the menu neither
 * does, so the last items were unreachable on exactly the short cards a reader collapses a session
 * down to. Position `fixed` in the body is measured against the window, so the height of the thing
 * the row happens to be in stops being part of the answer.
 *
 * Deliberately NOT shared with the profile menu: that one roves the arrow keys across four entries
 * and anchors itself upward against the window's bottom edge, and neither applies to a row.
 */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  /** Null until the layout pass has measured; the menu stays invisible until then. */
  const [placement, setPlacement] = useState<Placement | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // The keyboard has to land on the action without tabbing through the rest of the roster.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, [open]);

  const reposition = useCallback(() => {
    const button = trigger.current;
    const popup = menu.current;
    if (!button || !popup) return;
    // Closed rather than left hanging: the row this menu names has been scrolled out from under
    // it, so there is nothing for it to be the menu OF any more.
    if (!triggerIsVisible(button)) {
      setOpen(false);
      return;
    }
    setPlacement(placeMenu(button.getBoundingClientRect(), popup.getBoundingClientRect()));
  }, []);

  // Before paint, so the menu is measured and placed in the same commit that opens it rather than
  // appearing at the top-left corner for a frame.
  useLayoutEffect(() => {
    if (!open) return undefined;
    reposition();
    // Every scroller, not just the page: `capture` is what hears a scroll event, which does not
    // bubble. Without this the menu stays where the row USED to be the moment the canvas moves.
    globalThis.addEventListener?.("scroll", reposition, true);
    globalThis.addEventListener?.("resize", reposition);
    return () => {
      globalThis.removeEventListener?.("scroll", reposition, true);
      globalThis.removeEventListener?.("resize", reposition);
    };
  }, [open, reposition]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) globalThis.requestAnimationFrame?.(() => trigger.current?.focus());
  };

  // Dropped on close rather than kept, so a menu reopened after the page moved is never placed
  // from where the row was last time.
  useEffect(() => {
    if (!open) setPlacement(null);
  }, [open]);

  return (
    <span className="shrink-0">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((current) => !current)}
        // Named for its row, not just "More": a roster of eight would otherwise give a screen
        // reader eight identically named buttons with no way to tell which row it is on.
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary active:bg-background/70"
      >
        <EllipsisVertical className="size-4" aria-hidden />
      </button>
      {open ? createPortal(
        <div
          ref={menu}
          role="menu"
          aria-label={`Actions for ${label}`}
          // For anything that asks "is the focus still inside me" with a DOM containment test. The
          // React tree still has this menu inside its row, so React's own bubbling and its
          // enter/leave pairing are unaffected by the portal; a raw `node.contains(relatedTarget)`
          // is not, and the hover-preview sidebar dismisses itself on exactly that question.
          data-portal-menu=""
          style={{
            top: placement?.top ?? 0,
            left: placement?.left ?? 0,
            // Measured at its natural size on the first pass, then shown. Without this the menu
            // paints once in the corner of the window before it is placed.
            visibility: placement ? undefined : "hidden",
          }}
          className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            close();
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              // Focus goes back to the trigger, not nowhere. An action is a request, not a fact: if
              // it fails the row is still here and the keyboard is where it left off, and if it
              // succeeds the trigger has gone with the row and the focus call is a no-op.
              onClick={() => {
                close();
                item.onSelect();
              }}
              className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary active:bg-accent/80"
            >
              <item.icon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </span>
  );
}
