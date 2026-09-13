import { EllipsisVertical, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** The gap this menu keeps between itself and the edge it is measured against. */
const MARGIN = 8;

export interface RowMenuItem {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
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
 * Deliberately NOT shared with the profile menu: that one roves the arrow keys across four entries
 * and anchors itself upward against the window's bottom edge, and neither applies to a row.
 */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  /** Whether this opening has to go upward to stay inside whatever is clipping it. */
  const [upward, setUpward] = useState(false);
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

  /**
   * Chooses the direction at the moment of opening, against whatever is actually clipping this.
   *
   * A row menu lives inside a scroller more often than not -- a roster, a card, a transcript --
   * and a scroller clips its children on every side. Opening downward from a row near the bottom
   * therefore does not overflow into the page; it is cut off, and the last rows in a list are
   * exactly the ones a reader reaches for. Measured at open rather than fixed by a prop, because
   * the same row is near the bottom or not depending on where the list is scrolled to.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current;
    const popup = menu.current;
    if (!button || !popup) return;
    const below = button.getBoundingClientRect().bottom;
    const needed = popup.getBoundingClientRect().height + MARGIN;
    // The nearest ancestor that clips, or the viewport when nothing does.
    let limit = globalThis.innerHeight ?? 0;
    for (let node = button.parentElement; node; node = node.parentElement) {
      // The clipping values, named rather than everything-but-visible: `getComputedStyle` answers
      // with an empty string for a property nothing has set in some engines, and treating that as
      // a clipper makes the nearest wrapper the limit and sends every menu upward.
      const overflow = getComputedStyle(node).overflowY;
      if (overflow !== "auto" && overflow !== "scroll" && overflow !== "hidden") continue;
      limit = Math.min(limit, node.getBoundingClientRect().bottom);
      break;
    }
    setUpward(below + needed > limit);
  }, [open]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    setUpward(false);
    if (restoreFocus) globalThis.requestAnimationFrame?.(() => trigger.current?.focus());
  };

  return (
    <span className="relative shrink-0">
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
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={`Actions for ${label}`}
          className={
            "absolute right-0 z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl "
            + (upward ? "bottom-full mb-1" : "top-full mt-1")
          }
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
        </div>
      ) : null}
    </span>
  );
}
