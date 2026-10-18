import { Check, ShieldAlert, type LucideIcon } from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { placePopup, triggerIsVisible, type Placement } from "@/features/bots/menus/anchoredPlacement";
import { useDismissOnOutsidePress, useOverlayPlacement } from "@/hooks/dom/overlays";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useStateFor } from "@/hooks/state/useStateFor";

export interface MenuChoice<T extends string> {
  value: T;
  label: string;
  description: string;
  /** Drawn before the label; a warning choice without one gets a shield. */
  icon?: LucideIcon;
  /** Why it cannot be chosen; shown in place of the description, and the row is disabled. */
  unavailable?: string;
  /** Drawn in the warning colour with a shield, for a choice that removes a safeguard. */
  warning?: boolean;
}

export interface ChoiceMenuProps<T extends string> {
  /** The menu's accessible name, which says what is being chosen. */
  label: string;
  /** The current choice, checked in the list; null when it is not known. */
  value: T | null;
  choices: readonly MenuChoice<T>[];
  onChoose: (value: T) => void;
  trigger: {
    ariaLabel: string;
    title: string;
    className: string;
    disabled: boolean;
    content: ReactNode;
  };
}

/**
 * A control that shows one current choice and opens a list to pick another from.
 *
 * `RowMenu`'s shell -- rendered into `document.body` so a card's `overflow-hidden` cannot cut it,
 * placed against the window, closed on Escape, a pointer outside it, or its trigger scrolling out
 * of sight -- with radio rows instead of actions: each says what it is and what it does, the
 * current one is checked, and the arrow keys move between them. Separate from `RowMenu` because
 * that one is a list of verbs on a row, and its trigger is always the same three dots.
 */
export function ChoiceMenu<T extends string>({ label, value, choices, onChoose, trigger }: ChoiceMenuProps<T>) {
  const [open, setOpen] = useState(false);
  /** Null until the layout pass has measured; the menu stays invisible until then. */
  // Dropped on close, so a menu reopened after the page moved is never placed from before.
  const [placement, setPlacement] = useStateFor<Placement | null>(open, () => null);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useDismissOnOutsidePress(open, [menu, button], () => setOpen(false));

  // The keyboard lands on the current choice, so Enter on an unchanged mind changes nothing.
  useDomSync(() => {
    if (!open) return;
    const rows = enabledRows(menu.current);
    (rows.find((row) => row.getAttribute("aria-checked") === "true") ?? rows[0])?.focus();
  }, [open]);

  const reposition = useCallback(() => {
    const anchor = button.current;
    const popup = menu.current;
    if (!anchor || !popup) return;
    if (!triggerIsVisible(anchor)) {
      setOpen(false);
      return;
    }
    setPlacement(placePopup(anchor.getBoundingClientRect(), popup.getBoundingClientRect(), "start"));
  }, []);

  useOverlayPlacement(open, () => reposition(), [reposition]);


  const close = () => {
    setOpen(false);
    globalThis.requestAnimationFrame?.(() => button.current?.focus());
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={trigger.disabled}
        aria-label={trigger.ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={trigger.title}
        className={trigger.className}
      >
        {trigger.content}
      </button>
      {open ? createPortal(
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          data-portal-menu=""
          style={{
            top: placement?.top ?? 0,
            left: placement?.left ?? 0,
            visibility: placement ? undefined : "hidden",
          }}
          className="fixed z-50 w-72 max-w-[calc(100vw-16px)] overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-xl"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close();
              return;
            }
            if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
            const rows = enabledRows(menu.current);
            if (rows.length === 0) return;
            const at = rows.indexOf(document.activeElement as HTMLElement);
            let next: HTMLElement | undefined;
            if (step !== undefined) next = rows[(at + step + rows.length) % rows.length];
            else if (event.key === "Home") next = rows[0];
            else if (event.key === "End") next = rows[rows.length - 1];
            if (!next) return;
            event.preventDefault();
            next.focus();
          }}
        >
          {choices.map((choice) => {
            const checked = choice.value === value;
            const Icon = choice.icon ?? (choice.warning ? ShieldAlert : null);
            return (
              <button
                key={choice.value}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                disabled={choice.unavailable !== undefined}
                onClick={() => {
                  close();
                  if (!checked) onChoose(choice.value);
                }}
                className="flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary active:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                  {checked ? <Check className="size-4 text-primary" aria-hidden /> : null}
                </span>
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span
                    className={`flex items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium ${
                      choice.warning ? "text-amber-600 dark:text-amber-400" : "text-foreground"
                    }`}
                  >
                    {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden /> : null}
                    {choice.label}
                  </span>
                  <span className="text-xs leading-4 text-muted-foreground">
                    {choice.unavailable ?? choice.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function enabledRows(menu: HTMLElement | null): HTMLElement[] {
  return [...(menu?.querySelectorAll<HTMLElement>("[role='menuitemradio']:not(:disabled)") ?? [])];
}
