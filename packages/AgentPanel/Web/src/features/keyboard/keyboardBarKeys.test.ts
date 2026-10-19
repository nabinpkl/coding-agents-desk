import { afterEach, describe, expect, it, vi } from "vitest";
import { pressKeyboardBarKey } from "@/features/keyboard/keyboardBarKeys";

afterEach(() => {
  document.body.replaceChildren();
});

/** Fields laid out as a browser would: jsdom gives nothing a box, so each claims one. */
function fields(markup: string, scope: HTMLElement = document.body): HTMLElement[] {
  scope.insertAdjacentHTML("beforeend", markup);
  const all = [...scope.querySelectorAll<HTMLElement>("input, textarea, button")];
  for (const field of all) field.getClientRects = () => [new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList;
  return all;
}

describe("a bar key", () => {
  it("goes to the field's own handler first, and does nothing more once that takes it", () => {
    const [first, second] = fields("<textarea></textarea><input />");
    first!.addEventListener("keydown", (event) => {
      if (event.key === "Tab") event.preventDefault();
    });
    first!.focus();
    pressKeyboardBarKey(first!, "Tab");
    expect(document.activeElement).toBe(first);
    expect(second).toBeTruthy();
  });

  it("moves Tab to the next field a keyboard types into, past buttons and checkboxes, wrapping", () => {
    const [first, , , last] = fields('<input /><button>Go</button><input type="checkbox" /><textarea></textarea>');
    first!.focus();
    pressKeyboardBarKey(first!, "Tab");
    expect(document.activeElement).toBe(last);
    pressKeyboardBarKey(last!, "Tab");
    expect(document.activeElement).toBe(first);
  });

  it("keeps Tab inside the dialog the field is in", () => {
    fields("<input />");
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    const [inside, other] = fields("<input /><input />", dialog);
    inside!.focus();
    pressKeyboardBarKey(inside!, "Tab");
    expect(document.activeElement).toBe(other);
    pressKeyboardBarKey(other!, "Tab");
    expect(document.activeElement).toBe(inside);
  });

  it("moves the caret one character, and collapses a selection to the side the arrow points", () => {
    const [field] = fields("<textarea></textarea>");
    const text = field as HTMLTextAreaElement;
    text.value = "abcd";
    text.setSelectionRange(2, 2);
    pressKeyboardBarKey(text, "ArrowLeft");
    expect(text.selectionStart).toBe(1);
    pressKeyboardBarKey(text, "ArrowRight");
    pressKeyboardBarKey(text, "ArrowRight");
    expect(text.selectionStart).toBe(3);
    text.setSelectionRange(1, 3);
    pressKeyboardBarKey(text, "ArrowLeft");
    expect([text.selectionStart, text.selectionEnd]).toEqual([1, 1]);
    text.setSelectionRange(4, 4);
    pressKeyboardBarKey(text, "ArrowRight");
    expect(text.selectionStart).toBe(4);
  });

  it("asks the field's dialog to cancel on Escape, and closes it unless the dialog refuses", () => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    dialog.close = vi.fn();
    document.body.append(dialog);
    const [field] = fields("<input />", dialog);
    const cancel = vi.fn((event: Event) => event.preventDefault());
    dialog.addEventListener("cancel", cancel);
    pressKeyboardBarKey(field!, "Escape");
    expect(cancel).toHaveBeenCalled();
    expect(dialog.close).not.toHaveBeenCalled();
    dialog.removeEventListener("cancel", cancel);
    pressKeyboardBarKey(field!, "Escape");
    expect(dialog.close).toHaveBeenCalled();
  });
});
