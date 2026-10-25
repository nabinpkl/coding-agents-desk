import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyboardBar, OnKeyboardBar } from "@/features/keyboard/KeyboardBar";
import { publishKeyboardBar } from "@/features/keyboard/keyboardBarState";

afterEach(() => {
  act(() => publishKeyboardBar(null));
  document.body.replaceChildren();
});

function focusedField(): HTMLTextAreaElement {
  const field = document.createElement("textarea");
  document.body.append(field);
  field.focus();
  return field;
}

function show(
  field: HTMLElement,
  overrides: { suggestion?: string | null; scale?: number; pinching?: boolean; ownKeys?: boolean } = {},
) {
  act(() =>
    publishKeyboardBar({
      field,
      host: field.closest<HTMLElement>("dialog[open]") ?? document.body,
      viewport: { left: 0, bottom: 508, width: 390, scale: overrides.scale ?? 1 },
      pinching: overrides.pinching ?? false,
      suggestion: overrides.suggestion ?? null,
      ownKeys: overrides.ownKeys ?? false,
    }),
  );
}

describe("the keyboard bar", () => {
  it("draws nothing while no field has the keyboard up", () => {
    render(<KeyboardBar />);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("stands on the keyboard's top edge with Esc, Tab, the arrows and a way to put the keyboard away", () => {
    const field = focusedField();
    render(<KeyboardBar />);
    show(field);
    const bar = screen.getByRole("toolbar", { name: "Keyboard keys" });
    expect(bar.style.top).toBe("508px");
    expect(bar.style.width).toBe("390px");
    for (const name of ["Esc", "Tab", "←", "→", "Hide keyboard"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    const blur = vi.spyOn(field, "blur");
    fireEvent.click(screen.getByRole("button", { name: "Hide keyboard" }));
    expect(blur).toHaveBeenCalled();
  });

  it("keeps its size on the glass when the page is zoomed, and steps aside during a pinch", () => {
    const field = focusedField();
    render(<KeyboardBar />);
    show(field, { scale: 2, pinching: true });
    const bar = screen.getByRole("toolbar");
    expect(bar.style.width).toBe("780px");
    expect(bar.style.transform).toBe("scale(0.5) translateY(-100%) translateZ(0)");
    expect(bar.style.opacity).toBe("0");
  });

  it("offers the field's suggestion as a key that presses the field's own Tab", () => {
    const field = focusedField();
    const keys: string[] = [];
    field.addEventListener("keydown", (event) => {
      keys.push(event.key);
      event.preventDefault();
    });
    render(<KeyboardBar />);
    show(field, { suggestion: "run the tests" });
    fireEvent.click(screen.getByRole("button", { name: "Use suggestion: run the tests" }));
    expect(keys).toEqual(["Tab"]);
  });

  it("is drawn inside the open dialog the field is in, so the dialog does not make it inert", () => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);
    const field = document.createElement("input");
    dialog.append(field);
    render(<KeyboardBar />);
    show(field);
    expect(dialog.contains(screen.getByRole("toolbar"))).toBe(true);
  });

  it("never takes focus from the field when pressed", () => {
    const field = focusedField();
    render(<KeyboardBar />);
    show(field);
    const pressed = fireEvent.pointerDown(screen.getByRole("button", { name: "Tab" }));
    expect(pressed).toBe(false);
  });

  it("draws a field's own keys in place of its own, for the region whose field is focused", () => {
    const field = focusedField();
    const pressed: string[] = [];
    render(
      <>
        <KeyboardBar />
        <OnKeyboardBar focused>
          <button type="button" onClick={() => pressed.push("Ctrl")}>
            Ctrl
          </button>
        </OnKeyboardBar>
        <OnKeyboardBar focused={false}>
          <button type="button">Elsewhere</button>
        </OnKeyboardBar>
      </>,
    );
    show(field, { ownKeys: true });
    const bar = screen.getByRole("toolbar");
    const ctrl = screen.getByRole("button", { name: "Ctrl" });
    expect(bar.contains(ctrl)).toBe(true);
    expect(screen.queryByRole("button", { name: "Esc" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Elsewhere" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide keyboard" })).toBeTruthy();
    fireEvent.click(ctrl);
    expect(pressed).toEqual(["Ctrl"]);

    // A plain field next takes the bar's own keys back, and the region's keys leave with the slot.
    show(focusedField());
    expect(screen.queryByRole("button", { name: "Ctrl" })).toBeNull();
    expect(screen.getByRole("button", { name: "Esc" })).toBeTruthy();
  });
});
