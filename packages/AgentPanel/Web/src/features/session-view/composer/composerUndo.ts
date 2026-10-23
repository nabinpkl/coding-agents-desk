// Undo for the composer, kept by the panel rather than the browser.
//
// The field is a controlled textarea whose value more than the reader writes: the terminal pane's
// mirror adopts what the pane's box reads as, a send empties it, dictation adds to it. A value set
// that way wipes the browser's own undo, so after the mirror emptied a long draft Cmd+Z found
// nothing to bring back. This history keeps what the reader typed, a step per pause or per bigger
// edit, and whatever the field held just before something else replaced it.
//
// Noticed when the reader next acts rather than as it happens: the field's value at a keystroke is
// compared with the last one this history saw, so nothing watches the value while rendering.

import type { KeyboardEvent } from "react";
import { useRef } from "react";

export interface UndoHistory {
  past: readonly string[];
  future: readonly string[];
  /** The value the field held after the last edit or undo this history made; null before any. */
  seen: string | null;
  /** When that edit was, so typing without a pause is one step. */
  at: number;
}

/** Typing with no pause longer than this is one step. */
const PAUSE_MS = 1000;
/** Steps kept back. A draft is text, so this is cheap; it only stops a long session growing it. */
const KEPT = 200;

export const EMPTY_HISTORY: UndoHistory = { past: [], future: [], seen: null, at: 0 };

function pushed(stack: readonly string[], value: string): string[] {
  return stack[stack.length - 1] === value ? [...stack] : [...stack, value].slice(-KEPT);
}

/** Whether the field was replaced by something else since this history last saw it. */
function replaced(history: UndoHistory, current: string): history is UndoHistory & { seen: string } {
  return history.seen !== null && history.seen !== current;
}

/** The reader changing `current` to `next`, at `now`. */
export function recordEdit(history: UndoHistory, current: string, next: string, now: number): UndoHistory {
  let past = [...history.past];
  if (replaced(history, current)) {
    // What was lost, then what replaced it: two undos go back through both.
    past = pushed(pushed(past, history.seen), current);
  } else if (past.length === 0 || now - history.at > PAUSE_MS || Math.abs(next.length - current.length) > 1) {
    // A new step: after a pause, or a paste, a cut, or a selection typed over.
    past = pushed(past, current);
  }
  return { past, future: [], seen: next, at: now };
}

/** One step back from `current`, or null where there is nothing to go back to. */
export function undoEdit(history: UndoHistory, current: string): { history: UndoHistory; value: string } | null {
  const past = [...history.past];
  let value: string | undefined;
  if (replaced(history, current)) {
    value = history.seen;
  } else {
    do value = past.pop();
    while (value === current);
  }
  if (value === undefined) return null;
  return { history: { past, future: pushed(history.future, current), seen: value, at: 0 }, value };
}

/** One step forward again, or null: also after something else replaced the field since the undo. */
export function redoEdit(history: UndoHistory, current: string): { history: UndoHistory; value: string } | null {
  if (replaced(history, current)) return null;
  const future = [...history.future];
  const value = future.pop();
  if (value === undefined) return null;
  return { history: { past: pushed(history.past, current), future, seen: value, at: 0 }, value };
}

/** Cmd+Z and Shift+Cmd+Z on a Mac, Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y elsewhere. */
export function undoKey(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && event.ctrlKey && !event.shiftKey) return "redo";
  return null;
}

/**
 * The field's change and key handlers, with undo between them. `change` goes in place of the
 * editor's own `onChange`; `onKeyDown` returns true when it took the key.
 */
export function useComposerUndo(value: string, onChange: (value: string) => void) {
  const history = useRef<UndoHistory>(EMPTY_HISTORY);
  return {
    change(next: string) {
      history.current = recordEdit(history.current, value, next, Date.now());
      onChange(next);
    },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
      const direction = undoKey(event);
      if (direction === null) return false;
      // Taken even with nothing to undo, so the browser's own history, which the field's value
      // being set from outside has left wrong, cannot step it somewhere else.
      event.preventDefault();
      const step = direction === "undo" ? undoEdit(history.current, value) : redoEdit(history.current, value);
      if (step === null) return true;
      history.current = step.history;
      onChange(step.value);
      return true;
    },
  };
}
