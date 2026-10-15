// The band above the canvas for a machine whose Bot stream is down. Two different facts, and the
// reader has to be told the right one: a restart leaves the cards drawn, an unreachable peer
// leaves none.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CanvasNotices } from "@/features/bots/cards/canvasNotices";

describe("CanvasNotices", () => {
  it("says a machine whose Bots are still drawn is reconnecting", () => {
    render(
      <CanvasNotices
        machineErrors={[{ label: "Mac", reason: "stream failed", held: true }]}
        onCanvas={1}
        drawn={1}
        orphanedError={null}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Reconnecting to Mac. Its Bots are shown as they last were.");
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
