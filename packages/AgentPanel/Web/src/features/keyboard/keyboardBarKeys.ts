// What each key on the keyboard bar does to the field it is pressed for.
//
// A key is first delivered to the field as a key event, so every handler the panel already has for
// the real key answers this one too: a composer taking its suggestion on Tab, a command list moving
// on an arrow, a menu closing on Escape. Only when no handler takes it does the bar do the key's
// ordinary job itself, because a key event a page dispatches does nothing on its own: the browser
// does not move focus for it, move the caret, or cancel a dialog.

import { typesText } from "@/app/page/keyboardInset";

export type KeyboardBarKey = "Escape" | "Tab" | "ArrowLeft" | "ArrowRight";

/** The input types a keyboard is raised for; a checkbox or a button is not a field to Tab to. */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

function isTextField(element: HTMLElement): boolean {
  if (!typesText(element)) return false;
  if (element instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(element.type) && !element.disabled && !element.readOnly;
  }
  if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
  return true;
}

/** The next field a keyboard can type into, after `field`, in the dialog it is in or the page. */
function nextField(field: HTMLElement): HTMLElement | null {
  const scope: ParentNode = field.closest("dialog[open]") ?? document;
  const fields = [...scope.querySelectorAll<HTMLElement>("input, textarea, [contenteditable]")].filter(
    (candidate) => isTextField(candidate) && candidate.tabIndex >= 0 && candidate.getClientRects().length > 0,
  );
  const at = fields.indexOf(field);
  const next = fields[(at + 1) % fields.length];
  return next && next !== field ? next : null;
}

/** Moves the caret one character, or collapses a selection to the side the arrow points. */
function moveCaret(field: HTMLElement, direction: -1 | 1): void {
  if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
    // Null for the input types that keep no caret position, such as `number`.
    const start = field.selectionStart;
    const end = field.selectionEnd;
    if (start === null || end === null) return;
    const to =
      start !== end ? (direction < 0 ? start : end) : Math.min(field.value.length, Math.max(0, start + direction));
    field.setSelectionRange(to, to);
    return;
  }
  window.getSelection()?.modify("move", direction < 0 ? "backward" : "forward", "character");
}

/** Closes the dialog the field is in the way Escape would: its `cancel` first, which it may refuse. */
function cancelDialog(field: HTMLElement): void {
  const dialog = field.closest<HTMLDialogElement>("dialog[open]");
  if (!dialog) return;
  if (dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) dialog.close();
}

export function pressKeyboardBarKey(field: HTMLElement, key: KeyboardBarKey): void {
  const claimed = !field.dispatchEvent(
    new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }),
  );
  if (claimed) return;
  switch (key) {
    case "Tab":
      nextField(field)?.focus();
      return;
    case "Escape":
      cancelDialog(field);
      return;
    case "ArrowLeft":
      moveCaret(field, -1);
      return;
    case "ArrowRight":
      moveCaret(field, 1);
      return;
    default: {
      const unhandled: never = key;
      throw new Error(`unknown keyboard bar key ${String(unhandled)}`);
    }
  }
}
