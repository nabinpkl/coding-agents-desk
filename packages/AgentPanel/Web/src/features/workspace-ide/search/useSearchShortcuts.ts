// The keys that open the IDE's two searches, while the IDE is on screen.
//
// Double Shift and Cmd/Ctrl+P open quick open; Cmd/Ctrl+Shift+F opens text search. Listened for on
// the window in the capture phase, so they fire from anywhere inside the IDE -- the file viewer,
// the terminal's xterm, the tree -- before any of those handles the key. Mounted by the IDE
// surface, so they stop when it unmounts: a Canvas card is where a reader types to agents, and
// Shift there is not a shortcut.

import { useState } from "react";
import { useEventListener } from "@/hooks/dom/useEventListener";

/** Two Shift presses closer together than this are a double Shift, as JetBrains times it. */
export const DOUBLE_SHIFT_MS = 350;

/**
 * A detector for double Shift, kept apart from the DOM so its rules can be tested as data.
 *
 * Both presses must be a bare Shift -- not held (a key repeat is not a second press) and with no
 * other key between them, so typing `A` and then `B` with Shift held twice in a row never counts.
 */
export function doubleShiftDetector(): (event: Pick<KeyboardEvent, "key" | "repeat" | "timeStamp"
  | "metaKey" | "ctrlKey" | "altKey">) => boolean {
  let lastShift: number | null = null;
  return (event) => {
    if (event.key !== "Shift" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) {
      lastShift = null;
      return false;
    }
    if (lastShift !== null && event.timeStamp - lastShift <= DOUBLE_SHIFT_MS) {
      lastShift = null;
      return true;
    }
    lastShift = event.timeStamp;
    return false;
  };
}

export function useSearchShortcuts({
  onQuickOpen,
  onSearch,
}: {
  onQuickOpen: () => void;
  onSearch: () => void;
}): void {
  const [detect] = useState(doubleShiftDetector);
  useEventListener<KeyboardEvent>(window, "keydown", (event) => {
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    // Cmd+P is the browser's Print, and taken over on purpose: it is the quick open every editor
    // reader already has in their fingers.
    if (command && !event.shiftKey && !event.altKey && key === "p") {
      event.preventDefault();
      onQuickOpen();
      return;
    }
    if (command && event.shiftKey && !event.altKey && key === "f") {
      event.preventDefault();
      onSearch();
      return;
    }
    if (detect(event)) onQuickOpen();
  }, { capture: true });
}
