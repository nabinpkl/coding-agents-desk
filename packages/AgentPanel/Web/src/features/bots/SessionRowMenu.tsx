import { EllipsisVertical, Unlink } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The per-session actions menu, on a row that names one session a Bot has been given.
 *
 * Shared by the Bots sidebar and the Bot canvas, which show the same rows in two densities and
 * offer the same one action on them. Deliberately NOT shared with the profile menu: that one roves
 * the arrow keys across four entries and anchors itself upward against the window's bottom edge,
 * and neither applies to a single item on a list row.
 */
export function SessionRowMenu({
  label,
  onDetach,
}: {
  label: string;
  onDetach: () => void;
}) {
  const [open, setOpen] = useState(false);
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

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) globalThis.requestAnimationFrame?.(() => trigger.current?.focus());
  };

  return (
    <span className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((current) => !current)}
        // Named for its row, not just "More": a roster of eight sessions would otherwise give a
        // screen reader eight identically named buttons with no way to tell which row it is on.
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
          className="absolute top-full right-0 z-50 mt-1 min-w-44 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            close();
          }}
        >
          <button
            type="button"
            role="menuitem"
            // Focus goes back to the trigger, not nowhere. The removal is a request, not a fact:
            // if it fails the row is still here and the keyboard is where it left off, and if it
            // succeeds the trigger has gone with the row and the focus call is a no-op.
            onClick={() => {
              close();
              onDetach();
            }}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm text-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary active:bg-accent/80"
          >
            <Unlink className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Remove from bot</span>
          </button>
        </div>
      ) : null}
    </span>
  );
}
