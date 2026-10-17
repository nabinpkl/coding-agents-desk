/**
 * Picking one choice from a chip: what is checked, what can be chosen, and how the keyboard moves.
 * Placement is `RowMenu`'s and is pinned in its own test.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChoiceMenu, type MenuChoice } from "@/features/bots/menus/ChoiceMenu";

const CHOICES: MenuChoice<string>[] = [
  { value: "plan", label: "Plan", description: "Reads and plans." },
  { value: "auto", label: "Auto", description: "Runs routine actions." },
  { value: "bypass", label: "Bypass", description: "Runs everything.", warning: true, unavailable: "Started without it." },
];

function renderMenu(value: string | null = "auto") {
  const onChoose = vi.fn();
  render(
    <ChoiceMenu
      label="Permission mode"
      value={value}
      choices={CHOICES}
      onChoose={onChoose}
      trigger={{ ariaLabel: "Mode", title: "Choose", className: "", disabled: false, content: "Auto" }}
    />,
  );
  return { onChoose, open: () => fireEvent.click(screen.getByRole("button", { name: "Mode" })) };
}

afterEach(cleanup);

describe("a choice menu", () => {
  it("opens into the body with the current choice checked and focused", () => {
    const { open } = renderMenu();
    open();
    const menu = screen.getByRole("menu", { name: "Permission mode" });
    expect(menu.parentElement).toBe(document.body);
    const auto = screen.getByRole("menuitemradio", { name: /Auto/ });
    expect(auto.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(auto);
    expect(screen.getByRole("button", { name: "Mode" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("chooses another and closes, and choosing the current one changes nothing", () => {
    const { onChoose, open } = renderMenu();
    open();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Plan/ }));
    expect(onChoose).toHaveBeenCalledWith("plan");
    expect(screen.queryByRole("menu")).toBeNull();
    open();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Auto/ }));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("shows why an unavailable choice cannot be taken, and will not take it", () => {
    const { onChoose, open } = renderMenu();
    open();
    const bypass = screen.getByRole("menuitemradio", { name: /Bypass/ });
    expect(bypass).toHaveProperty("disabled", true);
    expect(bypass.textContent).toContain("Started without it.");
    expect(bypass.textContent).not.toContain("Runs everything.");
    fireEvent.click(bypass);
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("walks the choices it can take with the arrows, and closes on Escape", () => {
    const { open } = renderMenu("plan");
    open();
    const menu = screen.getByRole("menu");
    const plan = screen.getByRole("menuitemradio", { name: /Plan/ });
    const auto = screen.getByRole("menuitemradio", { name: /Auto/ });
    expect(document.activeElement).toBe(plan);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(auto);
    // Bypass is skipped, so the next step wraps back to the top.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(plan);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(auto);
    act(() => { fireEvent.keyDown(menu, { key: "Escape" }); });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes when a pointer lands outside it", () => {
    const { open } = renderMenu();
    open();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
