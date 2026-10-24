import { EllipsisVertical, type LucideIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placePopup, triggerIsVisible, type Placement } from "@/features/bots/menus/anchoredPlacement";
import { overlayHost, useDismissOnOutsidePress, useOverlayPlacement } from "@/hooks/dom/overlays";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useStateFor } from "@/hooks/state/useStateFor";

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
 * **The menu is rendered into `document.body`, not into the row.** It used to be an absolutely
 * positioned child, which meant the card decided what it could do: every canvas card sets
 * `overflow-hidden` to keep its own content inside its rounded corners, and a clipped child is cut
 * off at that edge rather than allowed to overflow the page. Choosing a direction -- which is what
 * this did before -- only helps while ONE direction fits. On a card shorter than the menu neither
 * does, so the last items were unreachable on exactly the short cards a reader collapses a session
 * down to. Position `fixed` in the body is measured against the window, so the height of the thing
 * the row happens to be in stops being part of the answer. Inside an open `<dialog>` -- the phone's
 * sidebar drawer -- it is rendered into that dialog instead (`overlayHost`).
 *
 * Deliberately NOT shared with the profile menu: that one roves the arrow keys across four entries
 * and anchors itself upward against the window's bottom edge, and neither applies to a row.
 */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  /** Where the menu is portalled, chosen as it opens: see `overlayHost`. */
  const [host, setHost] = useState<HTMLElement | null>(null);
  /** Null until the layout pass has measured; the menu stays invisible until then. */
  // Dropped on close, so a menu reopened after the page moved is never placed from before.
  const [placement, setPlacement] = useStateFor<Placement | null>(open, () => null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useDismissOnOutsidePress(open, [menu, trigger], () => setOpen(false));

  // The keyboard has to land on the action without tabbing through the rest of the roster.
  useDomSync(() => {
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
    setPlacement(placePopup(button.getBoundingClientRect(), popup.getBoundingClientRect()));
  }, [setPlacement]);

  // Before paint, so the menu is measured and placed in the same commit that opens it rather than
  // appearing at the top-left corner for a frame.
  useOverlayPlacement(open, () => reposition(), [reposition]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    // Only to a page that has lost it: an item that opens a dialog has put the focus in that
    // dialog by now, and taking it back to the trigger would leave the dialog unfocused.
    if (!restoreFocus) return;
    globalThis.requestAnimationFrame?.(() => {
      const holder = document.activeElement;
      if (holder === null || holder === document.body) trigger.current?.focus();
    });
  };

  return (
    <span className="shrink-0">
      <button
        ref={trigger}
        type="button"
        onClick={(event) => {
          setHost(overlayHost(event.currentTarget));
          setOpen((current) => !current);
        }}
        // Named for its row, not just "More": a roster of eight would otherwise give a screen
        // reader eight identically named buttons with no way to tell which row it is on.
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:bg-background focus-visible:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary active:bg-background/70"
      >
        <EllipsisVertical className="size-4" aria-hidden />
      </button>
      {open && host
        ? createPortal(
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
                  // Sized from the same token as the rows this menu acts on, rather than a hardcoded
                  // `text-sm`. At 14px it was a point larger than every title it offers to rename,
                  // fork or detach, which puts the menu above its own subject; it also sat outside
                  // the reader's font settings, so resizing the roster left the menus behind.
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary active:bg-accent/80"
                >
                  <item.icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              ))}
            </div>,
            host,
          )
        : null}
    </span>
  );
}
