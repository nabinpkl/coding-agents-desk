import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ImageLightbox } from "@/features/image-viewer/ImageLightbox";

function open(url = "/api/image/1") {
  return render(<ImageLightbox title="Image" url={url} alt="A picture" onClose={() => {}} />);
}

/** The scale the picture is actually drawn at, read off the transform it carries. */
function scale(): number {
  const image = screen.getByAltText("A picture");
  const match = /scale\(([\d.]+)\)/.exec(image.style.transform);
  return match ? Number(match[1]) : NaN;
}

describe("ImageLightbox zoom", () => {
  it("opens at fit, with nothing to reset and nothing to zoom out of", () => {
    open();
    expect(scale()).toBe(1);
    expect(screen.getByRole("button", { name: "Zoom out" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Zoom in" })).toHaveProperty("disabled", false);
  });

  it("zooms in and back out, and says where the view is", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(scale()).toBeGreaterThan(1);
    expect(screen.getByRole("button", { name: "Reset zoom" }).textContent).toBe(`${Math.round(scale() * 100)}%`);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(scale()).toBeCloseTo(1, 5);
  });

  it("stops at fit rather than shrinking the picture below it", () => {
    open();
    const out = screen.getByRole("button", { name: "Zoom in" });
    fireEvent.click(out);
    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    }
    expect(scale()).toBe(1);
  });

  it("puts the view back with Reset, and with the 0 key", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(scale()).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(scale()).toBe(1);

    const dialog = screen.getByAltText("A picture").closest("dialog")!;
    fireEvent.keyDown(dialog, { key: "+" });
    expect(scale()).toBeGreaterThan(1);
    fireEvent.keyDown(dialog, { key: "0" });
    expect(scale()).toBe(1);
  });

  it("zooms on a wheel over the picture", () => {
    open();
    const frame = screen.getByAltText("A picture").parentElement!;
    fireEvent.wheel(frame, { deltaY: -200, clientX: 0, clientY: 0 });
    expect(scale()).toBeGreaterThan(1);
  });

  // A second picture opening inside the first one's magnification would show a crop of something
  // the reader has not seen whole yet.
  it("returns to fit when another picture takes the dialog over", () => {
    const { rerender } = open();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(scale()).toBeGreaterThan(1);
    rerender(<ImageLightbox title="Image" url="/api/image/2" alt="A picture" onClose={() => {}} />);
    expect(scale()).toBe(1);
  });
});
