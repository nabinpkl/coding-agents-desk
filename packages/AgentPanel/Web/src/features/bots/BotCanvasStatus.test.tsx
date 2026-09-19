/**
 * What the canvas's status block says, and when it says less.
 *
 * Tested at the component rather than through the shell because the shell's harness mounts a
 * single-machine panel -- one machine renders no chips by design -- and a second machine there
 * means a second sidecar, two feeds and two rosters to stand up for a control whose whole job is
 * a count, four labels and a toggle.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BotCanvasStatus } from "@/features/bots/BotCanvasStatus";

const MACHINES = [
  { key: "dev", label: "dev" },
  { key: "oracle", label: "oracle" },
];
const COUNTS = (key: string) => (key === "dev" ? 7 : 1);

afterEach(cleanup);

describe("BotCanvasStatus", () => {
  it("says the canvas total and breaks it down by machine", () => {
    render(
      <BotCanvasStatus total={8} machines={MACHINES} hidden={new Set()} countOf={COUNTS} onToggle={() => undefined} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("8 bots on the canvas");
    const group = screen.getByRole("group", { name: "Machines on the canvas" });
    expect(group).toHaveTextContent("dev7");
    expect(group).toHaveTextContent("oracle1");
  });

  it("keeps a hidden machine inside both numbers, which is what pressing it would bring back", () => {
    render(
      <BotCanvasStatus total={8} machines={MACHINES} hidden={new Set(["oracle"])} countOf={COUNTS} onToggle={() => undefined} />,
    );
    // Both count what is ON the canvas rather than what is on screen, so hiding a machine moves
    // neither. A chip with nothing behind it and a chip holding back six cards read identically
    // otherwise, and the second is the one a reader is hunting for.
    expect(screen.getByRole("status")).toHaveTextContent("8 bots on the canvas");
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
        machines={[{ key: "peer-1", label: "oracle" }]}
        hidden={new Set()}
        countOf={() => 1}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /oracle/ }));
    expect(onToggle).toHaveBeenCalledWith("peer-1");
  });

  it("keeps the count on a single-machine panel and drops the chips", () => {
    // Which is every panel until a peer is declared. A lone chip could only tell a reader what they
    // already know, and could only turn everything off; the count is a fact about the canvas.
    render(
      <BotCanvasStatus total={1} machines={[]} hidden={new Set()} countOf={() => 0} onToggle={() => undefined} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 bot on the canvas");
    expect(screen.queryByRole("group", { name: "Machines on the canvas" })).toBeNull();
  });
});
