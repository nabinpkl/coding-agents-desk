import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ComposerImageStrip } from "@/features/cli-input/ComposerImageStrip";

const SENT = { id: 1, url: "blob:one" };
/** An image put into the pane by whoever is sitting there: a token, and no bytes this side saw. */
const THEIRS = { id: 4, url: null };

describe("the composer's image strip", () => {
  it("shows nothing at all when the composer is holding no images", () => {
    const { container } = render(
      <ComposerImageStrip images={[]} onRemove={() => {}} disabled={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("offers remove without waiting to be hovered", () => {
    // Half the readers of this panel are on a phone. A control revealed by hover is a control
    // that is not there, so both are drawn from the start and separated by size instead.
    const remove = vi.fn();
    render(<ComposerImageStrip images={[SENT]} onRemove={remove} disabled={false} />);
    const button = screen.getByRole("button", { name: "Remove image #1 from the composer" });
    expect(button).toBeVisible();
    fireEvent.click(button);
    expect(remove).toHaveBeenCalledWith(1);
  });

  it("opens the picture larger when it is pressed, and closes on Escape", () => {
    render(<ComposerImageStrip images={[SENT]} onRemove={() => {}} disabled={false} />);
    expect(screen.queryByRole("img", { name: "Image #1 in the composer" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open image #1 larger" }));
    expect(screen.getByRole("img", { name: "Image #1 in the composer" })).toBeVisible();

    fireEvent(screen.getByLabelText("Image #1"), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("img", { name: "Image #1 in the composer" })).toBeNull();
  });

  it("carries a full-width remove in the opened view, for a reader who did not aim at the corner", () => {
    const remove = vi.fn();
    render(<ComposerImageStrip images={[SENT]} onRemove={remove} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Open image #1 larger" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove from the composer" }));
    expect(remove).toHaveBeenCalledWith(1);
    // And the view goes with it, rather than holding a picture of something no longer there.
    expect(screen.queryByRole("img", { name: "Image #1 in the composer" })).toBeNull();
  });

  it("closes the opened view when its image leaves the composer some other way", () => {
    // Submitted in the pane, or removed from the strip behind it. Either way the composer is no
    // longer carrying what is on screen.
    const { rerender } = render(
      <ComposerImageStrip images={[SENT]} onRemove={() => {}} disabled={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open image #1 larger" }));
    rerender(<ComposerImageStrip images={[]} onRemove={() => {}} disabled={false} />);
    expect(screen.queryByRole("img", { name: "Image #1 in the composer" })).toBeNull();
  });

  it("names an image it has no picture of, and still lets it be taken out", () => {
    const remove = vi.fn();
    render(<ComposerImageStrip images={[THEIRS]} onRemove={remove} disabled={false} />);
    expect(screen.getByText("#4")).toBeVisible();
    // Nothing to enlarge, so nothing to press for it.
    expect(screen.queryByRole("button", { name: "Open image #4 larger" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove image #4 from the composer" }));
    expect(remove).toHaveBeenCalledWith(4);
  });

  it("refuses removal while the composer is disabled, rather than looking available", () => {
    const remove = vi.fn();
    render(<ComposerImageStrip images={[SENT]} onRemove={remove} disabled />);
    const button = screen.getByRole("button", { name: "Remove image #1 from the composer" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(remove).not.toHaveBeenCalled();
  });
});
