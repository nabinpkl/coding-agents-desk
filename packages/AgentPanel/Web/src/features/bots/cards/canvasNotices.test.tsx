// What the canvas says about a machine whose Bot stream is down. Two different facts, and the reader
// has to be told the right one: a restart leaves the cards drawn, an unreachable peer leaves none.
// And the first is said OVER the cards, so its coming and going moves none of them.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CanvasNotices, CanvasReconnecting } from "@/features/bots/cards/canvasNotices";

describe("CanvasReconnecting", () => {
  it("says a machine whose Bots are still drawn is reconnecting, as an overlay", () => {
    render(<CanvasReconnecting machineErrors={[{ label: "Mac", reason: "stream failed", held: true }]} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Reconnecting to Mac…");
    // Absolute, so it takes no room in the canvas column and the cards under it stay where they are.
    expect(status.className).toContain("absolute");
  });

  it("draws nothing for a machine with nothing held", () => {
    const { container } = render(
      <CanvasReconnecting machineErrors={[{ label: "oracle", reason: "stream failed", held: false }]} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("CanvasNotices", () => {
  it("leaves a reconnecting machine to the overlay rather than banding it", () => {
    const { container } = render(
      <CanvasNotices
        machineErrors={[{ label: "Mac", reason: "stream failed", held: true }]}
        onCanvas={1}
        drawn={1}
        orphanedError={null}
      />,
    );
    expect(container.innerHTML).toBe("");
  });

  it("says a machine with nothing drawn is not answering, and why", () => {
    render(
      <CanvasNotices
        machineErrors={[{ label: "oracle", reason: "stream failed", held: false }]}
        onCanvas={1}
        drawn={1}
        orphanedError={null}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe(
      "oracle is not answering, so its Bots are not on the canvas: stream failed",
    );
  });
});
