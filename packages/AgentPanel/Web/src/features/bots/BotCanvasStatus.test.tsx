/**
 * What the canvas's status block says, and when it says less.
 *
 * Tested at the component rather than through the shell because the shell's harness mounts a
 * single-machine panel -- one machine renders no chips by design -- and a second machine there
 * means a second sidecar, two feeds and two rosters to stand up for a control whose whole job is
 * a count, four labels and a toggle.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BotCanvasStatus } from "@/features/bots/BotCanvasStatus";

const MACHINES = [
  { key: "dev", label: "dev" },
  { key: "oracle", label: "oracle" },
];
const COUNTS = (key: string) => (key === "dev" ? 7 : 1);
const ZOOM = { on: false, onToggle: () => undefined };
const ROOM = { size: 0, onChange: () => undefined };

afterEach(cleanup);

describe("BotCanvasStatus", () => {
  it("says the canvas total and breaks it down by machine", () => {
    render(
      <BotCanvasStatus total={8} shown={8} machines={MACHINES} hidden={new Set()} countOf={COUNTS} onToggle={() => undefined} zoom={ZOOM} room={ROOM} />,
    );
    // Plain "8", not "8 of 8": a ratio where both halves agree is a question raised for nothing.
    expect(screen.getByRole("status")).toHaveTextContent("8 bots on the canvas");
    expect(screen.getByRole("status").textContent).not.toMatch(/hidden|of 8/);
    const group = screen.getByRole("group", { name: "Machines on the canvas" });
    expect(group).toHaveTextContent("dev7");
    expect(group).toHaveTextContent("oracle1");
  });

  it("says how many cards a hidden machine is holding back", () => {
    render(
      <BotCanvasStatus total={8} shown={7} machines={MACHINES} hidden={new Set(["oracle"])} countOf={COUNTS} onToggle={() => undefined} zoom={ZOOM} room={ROOM} />,
    );
    // The whole point of the line: a reader who does not remember pressing a chip sees a strip one
    // card short, and this is the only thing that says why. `total` still counts what is ON the
    // canvas rather than what is on screen, so the chip's own count does not move either.
    expect(screen.getByRole("status")).toHaveTextContent("7 of 8 bots on the canvas, 1 hidden");
    const oracle = screen.getByRole("button", { name: /oracle/ });
    expect(oracle).toHaveAttribute("aria-pressed", "false");
    expect(oracle).toHaveTextContent("1");
    expect(oracle).toHaveAttribute("title", "Show oracle's Bots on the canvas");
    expect(screen.getByRole("button", { name: /dev/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles by machine key rather than by label", () => {
    const onToggle = vi.fn();
    render(
      <BotCanvasStatus
        total={1}
        shown={1}
        machines={[{ key: "peer-1", label: "oracle" }]}
        hidden={new Set()}
        countOf={() => 1}
        onToggle={onToggle}
        zoom={ZOOM}
        room={ROOM}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /oracle/ }));
    expect(onToggle).toHaveBeenCalledWith("peer-1");
  });

  it("keeps the count on a single-machine panel and drops the chips", () => {
    // Which is every panel until a peer is declared. A lone chip could only tell a reader what they
    // already know, and could only turn everything off; the count is a fact about the canvas.
    render(
      <BotCanvasStatus total={1} shown={1} machines={[]} hidden={new Set()} countOf={() => 0} onToggle={() => undefined} zoom={ZOOM} room={ROOM} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 bot on the canvas");
    expect(screen.queryByRole("group", { name: "Machines on the canvas" })).toBeNull();
  });

  it("offers room to move the fitted canvas by size, and only while there is one", () => {
    // The gutter is around what the fit mode draws into, and at the canvas's own size there is no
    // such box -- so the control says so by being disabled rather than by doing nothing.
    const onChange = vi.fn();
    const { rerender } = render(
      <BotCanvasStatus
        total={8}
        shown={8}
        machines={MACHINES}
        hidden={new Set()}
        countOf={COUNTS}
        onToggle={() => undefined}
        zoom={ZOOM}
        room={{ size: 0, onChange }}
      />,
    );
    const group = screen.getByRole("group", { name: "Room to move the canvas" });
    expect(within(group).getByRole("button", { name: "256" })).toBeDisabled();
    expect(within(group).getByRole("button", { name: "None" }))
      .toHaveAttribute("title", "Fit the whole canvas first: the room is around what that draws.");

    rerender(
      <BotCanvasStatus
        total={8}
        shown={8}
        machines={MACHINES}
        hidden={new Set()}
        countOf={COUNTS}
        onToggle={() => undefined}
        zoom={{ on: true, onToggle: () => undefined }}
        room={{ size: 64, onChange }}
      />,
    );
    const live = screen.getByRole("group", { name: "Room to move the canvas" });
    // The size the canvas is actually at is the pressed one, and every other size is one press
    // away rather than a cycle through the ones in between.
    expect(within(live).getByRole("button", { name: "64" })).toHaveAttribute("aria-pressed", "true");
    expect(within(live).getByRole("button", { name: "None" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(live).getByRole("button", { name: "512" }));
    expect(onChange).toHaveBeenCalledWith(512);
  });

  it("offers the whole canvas at once, and says which way that is set", () => {
    // The canvas carries no chrome of its own -- it is a strip of cards as tall as their own
    // rosters, so a row spent on a control is a row the cards do not get -- which makes this the
    // only way in and out of the mode. A toggle nobody can find is worse than no toggle.
    const onToggle = vi.fn();
    const { rerender } = render(
      <BotCanvasStatus
        total={8}
        shown={8}
        machines={MACHINES}
        hidden={new Set()}
        countOf={COUNTS}
        onToggle={() => undefined}
        zoom={{ on: false, onToggle }}
        room={ROOM}
      />,
    );
    const fit = screen.getByRole("button", { name: "Fit the whole canvas" });
    expect(fit).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(fit);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <BotCanvasStatus
        total={8}
        shown={8}
        machines={MACHINES}
        hidden={new Set()}
        countOf={COUNTS}
        onToggle={() => undefined}
        zoom={{ on: true, onToggle }}
        room={ROOM}
      />,
    );
    // Pressed, and the title says what pressing it again does rather than repeating its label.
    expect(screen.getByRole("button", { name: "Fit the whole canvas" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Fit the whole canvas" }))
      .toHaveAttribute("title", "Draw the canvas at its own size again");
  });
});
