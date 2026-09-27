import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Settings2 } from "lucide-react";
import {
  applyTypePreference,
  loadTypePreference,
  storeTypePreference,
  TYPE_FAMILIES,
  TYPE_WEIGHTS,
  type TypePreference,
} from "@/features/appearance/typePreferences";

/** The gap this menu keeps between itself and the edge of the window. */
const MARGIN = 8;
/** The gap between the trigger and the menu. */
const GAP = 4;

/**
 * The face and weight the panel is set in, behind a settings button in the surface bar.
 *
 * Two native `<select>`s in a dialog portalled to `document.body`, because the bar is a
 * horizontally scrolling flex row and anything positioned inside it is clipped by its own
 * scroller. The phone gets its own wheel picker for free, and keyboard and screen-reader
 * behaviour arrives correct rather than reimplemented.
 *
 * The write happens in one effect on the value rather than beside each change, which is what
 * keeps a later third caller from being the one that forgets to persist.
 */
export function TypeSettings(): React.ReactElement {
  const [type, setType] = useState<TypePreference>(loadTypePreference);
  const [open, setOpen] = useState(false);
  /** Null until the layout pass has measured; the dialog stays invisible until then. */
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    applyTypePreference(document.documentElement, type);
    storeTypePreference(type);
  }, [type]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (dialog.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open ]);

  // The first select, so the keyboard lands on a control without tabbing past the page.
  useEffect(() => {
    if (!open) return;
    dialog.current?.querySelector<HTMLElement>("select")?.focus();
  }, [open]);

  // Before paint, so the dialog is measured and placed in the same commit that opens it rather
  // than appearing at the top-left corner for a frame. Below the trigger and right-aligned to
  // it, clamped on both axes so a trigger at any edge still gets a dialog entirely on screen.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const button = trigger.current;
      const popup = dialog.current;
      if (!button || !popup) return;
      const anchor = button.getBoundingClientRect();
      const box = popup.getBoundingClientRect();
      const viewportHeight = globalThis.innerHeight || 0;
      const viewportWidth = globalThis.innerWidth || 0;
      const top = Math.max(
        MARGIN,
        Math.min(anchor.bottom + GAP, viewportHeight - MARGIN - box.height),
      );
      setPlacement({
        top,
        left: Math.max(MARGIN, Math.min(anchor.right - box.width, viewportWidth - MARGIN - box.width)),
      });
    };
    place();
    globalThis.addEventListener?.("resize", place);
    return () => globalThis.removeEventListener?.("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) setPlacement(null);
  }, [open]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) globalThis.requestAnimationFrame?.(() => trigger.current?.focus());
  };

  const select =
    "min-h-8 w-full cursor-pointer rounded-md bg-transparent px-1 py-1 " +
    "text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground " +
    "outline-none transition-colors hover:bg-muted/60 hover:text-foreground " +
    "focus-visible:ring-2 focus-visible:ring-primary";

  return (
    <span className="flex shrink-0 items-center self-center">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-label="Display settings"
        title="The face this panel is set in, and how heavy. Remembered in this browser."
        aria-haspopup="dialog"
        aria-expanded={open}
        className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground
          outline-none transition-colors hover:bg-muted/60 hover:text-foreground
          focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
      >
        <Settings2 className="size-4" aria-hidden />
      </button>
      {open ? createPortal(
        <div
          ref={dialog}
          role="dialog"
          aria-label="Display settings"
          style={{
            top: placement?.top ?? 0,
            left: placement?.left ?? 0,
            // Measured at its natural size on the first pass, then shown. Without this the
            // dialog paints once in the corner of the window before it is placed.
            visibility: placement ? undefined : "hidden",
          }}
          className="fixed z-50 w-52 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-xl"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            close();
          }}
        >
          <div role="group" aria-label="Panel type" className="grid gap-1">
            <label
              htmlFor="agent-panel-type-family"
              className="px-1 text-xs font-medium text-muted-foreground"
            >
              Typeface
            </label>
            <select
              id="agent-panel-type-family"
              aria-label="Typeface"
              value={type.family}
              onChange={(event) => setType((was) => ({ ...was, family: event.target.value }))}
              className={select}
            >
              {TYPE_FAMILIES.map((family) => (
                <option key={family.id} value={family.id}>
                  {family.label}
                </option>
              ))}
            </select>
            <label
              htmlFor="agent-panel-type-weight"
              className="px-1 pt-1 text-xs font-medium text-muted-foreground"
            >
              Text weight
            </label>
            <select
              id="agent-panel-type-weight"
              aria-label="Text weight"
              title="The weight of ordinary text. Every heavier step moves with it."
              value={type.weight}
              onChange={(event) => setType((was) => ({ ...was, weight: Number(event.target.value) }))}
              className={select}
            >
              {TYPE_WEIGHTS.map((weight) => (
                <option key={weight} value={weight}>
                  {weight}
                </option>
              ))}
            </select>
          </div>
        </div>,
        document.body,
      ) : null}
    </span>
  );
}
