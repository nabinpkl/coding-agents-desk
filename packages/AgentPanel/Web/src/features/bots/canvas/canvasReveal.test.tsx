import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { revealOnCanvas, useRevealOnCanvas } from "@/features/bots/canvas/canvasReveal";

const scrolled = vi.fn();

function Canvas({ cards }: { cards: string[] }) {
  const canvas = useRef<HTMLDivElement | null>(null);
  useRevealOnCanvas(canvas);
  return (
    <div ref={canvas}>
      {cards.map((key) => (
        <div
          key={key}
          data-session-key={key}
          ref={(node) => {
            if (node) node.scrollIntoView = () => scrolled(key);
          }}
        />
      ))}
    </div>
  );
}

afterEach(() => {
  scrolled.mockReset();
  vi.useRealTimers();
});

describe("useRevealOnCanvas", () => {
  it("scrolls to a card that is already drawn, once", () => {
    const view = render(<Canvas cards={["claude:a", "claude:b"]} />);
    act(() => revealOnCanvas("claude:b"));
    view.rerender(<Canvas cards={["claude:a", "claude:b"]} />);
    expect(scrolled.mock.calls).toEqual([["claude:b"]]);
  });

  // The order the page uses when a Bot comes back on the canvas: asked first, drawn after.
  it("waits for a card that is drawn after it was asked for", () => {
    const view = render(<Canvas cards={["claude:a"]} />);
    act(() => revealOnCanvas("claude:c"));
    expect(scrolled).not.toHaveBeenCalled();
    view.rerender(<Canvas cards={["claude:a", "claude:c"]} />);
    expect(scrolled.mock.calls).toEqual([["claude:c"]]);
  });

  it("gives up on a card that does not come in time", () => {
    vi.useFakeTimers();
    const view = render(<Canvas cards={[]} />);
    act(() => revealOnCanvas("claude:d"));
    vi.advanceTimersByTime(6_000);
    view.rerender(<Canvas cards={["claude:d"]} />);
    expect(scrolled).not.toHaveBeenCalled();
  });
});
