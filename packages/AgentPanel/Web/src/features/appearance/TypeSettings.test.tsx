import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypeSettings } from "@/features/appearance/TypeSettings";
import { DEFAULT_TYPE } from "@/features/appearance/typePreferences";

const STORAGE_KEY = "agent-panel.type";

function stored(): { family: string; weight: number } {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
}

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.documentElement.removeAttribute("style");
});

function open(): void {
  render(<TypeSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Display settings" }));
}

describe("TypeSettings", () => {
  it("keeps the face and weight behind a button until asked", () => {
    render(<TypeSettings />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByLabelText("Typeface")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Display settings" }));
    expect(screen.getByRole("dialog", { name: "Display settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Typeface")).toBeInTheDocument();
    expect(screen.getByLabelText("Text weight")).toBeInTheDocument();
  });

  it("remembers a chosen face and weight the way the bar controls did", () => {
    open();
    fireEvent.change(screen.getByLabelText("Typeface"), { target: { value: "geist" } });
    fireEvent.change(screen.getByLabelText("Text weight"), { target: { value: "500" } });

    expect(stored()).toEqual({ family: "geist", weight: 500 });
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toContain("Geist");
  });

  it("closes on Escape and hands focus back to the button", async () => {
    open();
    const button = screen.getByRole("button", { name: "Display settings" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Focus returns on the next animation frame, not in the key handler.
    await waitFor(() => expect(document.activeElement).toBe(button));
  });

  it("opens on the reader's remembered choice, not the default", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ family: "roboto", weight: 450 }));
    open();
    expect(screen.getByLabelText("Typeface")).toHaveValue("roboto");
    expect(screen.getByLabelText("Text weight")).toHaveValue("450");
    expect(DEFAULT_TYPE).toEqual({ family: "inter", weight: 400 });
  });
});
