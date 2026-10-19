// The row of keys that stands on an iPhone's keyboard for whatever text field is focused.
//
// The phone's keyboard has no Esc, no Tab and no arrows, and nothing to take a suggestion with. This
// row is that missing half, for every field rather than one surface: the page gives up the
// keyboard's height and this row's (`app/page/keyboardInset.ts`), and the row is drawn over the
// strip it gave up. Mounted once, at the panel's root; it draws only while the keyboard is up.
//
// Two placement rules, each against a way it would otherwise vanish:
//
// - It is a popover, so it is drawn in the top layer, above a modal dialog and its backdrop. It is
//   shown again whenever the focused field changes, because the last thing shown there is the one
//   drawn on top, and a dialog opened since would otherwise cover it.
// - It is drawn inside the modal dialog the field is in, when there is one: a modal dialog makes
//   everything outside it inert, so a row drawn outside could be seen and not pressed.
//
// A field whose keys are not the bar's (the terminal composer's, which go to a pane) brings its own
// row instead: it marks itself `data-keyboard-bar="keys"` and draws them with `OnKeyboardBar`, into
// a slot the bar leaves where its own keys would be.
//
// It keeps to the glass rather than the page. Zoomed in, the page is drawn larger, so the row is
// placed on the visible part of the page and scaled back down by the zoom; during a pinch, whose
// numbers arrive late, it steps out of sight rather than trailing the fingers.

import { KeyboardOff } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { KeyRailButton } from "@/features/keyboard/KeyRailButton";
import { pressKeyboardBarKey, type KeyboardBarKey } from "@/features/keyboard/keyboardBarKeys";
import {
  keyboardBarHeight,
  keyboardBarSnapshot,
  publishKeyboardBarSlot,
  subscribeKeyboardBar,
  type KeyboardBarState,
} from "@/features/keyboard/keyboardBarState";
import { useDomSync } from "@/hooks/dom/useDomSync";

const KEYS: { label: string; key: KeyboardBarKey }[] = [
  { label: "Esc", key: "Escape" },
  { label: "Tab", key: "Tab" },
  { label: "←", key: "ArrowLeft" },
  { label: "→", key: "ArrowRight" },
];

export function KeyboardBar() {
  const bar = useSyncExternalStore(subscribeKeyboardBar, keyboardBarSnapshot);
  if (!bar.field || !bar.host) return null;
  return createPortal(<KeyboardBarRow bar={bar} field={bar.field} />, bar.host);
}

/**
 * A field's own keys, drawn on the keyboard bar while that field has the keyboard. `focused` says
 * the field is this region's; the bar only leaves room for keys when the field asked for it.
 */
export function OnKeyboardBar({ focused, children }: { focused: boolean; children: ReactNode }) {
  const bar = useSyncExternalStore(subscribeKeyboardBar, keyboardBarSnapshot);
  if (!focused || !bar.ownKeys || !bar.slot) return null;
  return createPortal(children, bar.slot);
}

function KeyboardBarRow({ bar, field }: { bar: KeyboardBarState; field: HTMLElement }) {
  // The element itself rather than a ref, so it is raised whenever it is there, however it arrived.
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  // Into the top layer, again for each field focused: see the file's head.
  useDomSync(() => {
    if (!row || typeof row.showPopover !== "function") return;
    if (row.matches(":popover-open")) row.hidePopover();
    row.showPopover();
  }, [row, field]);

  const { left, bottom, width, scale } = bar.viewport;
  return (
    <div
      ref={setRow}
      popover="manual"
      role="toolbar"
      aria-label="Keyboard keys"
      // A press must never take focus: the field losing it would take the keyboard down with it.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      // Placed at the visible bottom edge and scaled back by the zoom about its own top left, after
      // lifting it by its own height, so its bottom stays on that edge whatever the scale.
      style={{
        position: "fixed",
        inset: "auto",
        left,
        top: bottom,
        width: width * scale,
        height: keyboardBarHeight(bar.ownKeys),
        transform: `scale(${1 / scale}) translateY(-100%)`,
        transformOrigin: "top left",
        opacity: bar.pinching ? 0 : 1,
      }}
      className="m-0 flex items-center gap-1 overflow-hidden border-0 border-t border-border bg-background py-1 pr-[max(6px,env(safe-area-inset-right))] pl-[max(6px,env(safe-area-inset-left))] text-foreground motion-safe:transition-opacity"
    >
      {bar.ownKeys ? (
        // Where the field's own keys are drawn (`OnKeyboardBar`); the element is handed over as it
        // arrives and withdrawn as it goes.
        <div ref={publishKeyboardBarSlot} className="flex h-full min-w-0 flex-1 items-center" />
      ) : (
        <>
          {bar.suggestion ? (
            <button
              type="button"
              // Tab is how the field takes its own suggestion, so taking it here is pressing Tab there.
              onClick={() => pressKeyboardBarKey(field, "Tab")}
              aria-label={`Use suggestion: ${bar.suggestion}`}
              className="h-9 min-w-0 flex-1 cursor-pointer truncate rounded border border-border bg-muted px-3 text-left text-sm text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary active:bg-accent"
            >
              {bar.suggestion}
            </button>
          ) : (
            <span className="flex-1" />
          )}
          {KEYS.map(({ label, key }) => (
            <KeyRailButton
              key={key}
              label={label}
              className="h-9 w-11 shrink-0 text-sm"
              onClick={() => pressKeyboardBarKey(field, key)}
            />
          ))}
        </>
      )}
      <button
        type="button"
        onClick={() => field.blur()}
        aria-label="Hide keyboard"
        title="Hide keyboard"
        className="flex h-9 w-11 shrink-0 cursor-pointer items-center justify-center rounded border border-border bg-muted text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary active:bg-accent"
      >
        <KeyboardOff className="size-4" aria-hidden />
      </button>
    </div>
  );
}
