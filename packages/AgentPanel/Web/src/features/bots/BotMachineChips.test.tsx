/**
 * What the machine chips say, and when they say nothing at all.
 *
 * Tested at the component rather than through the shell because the shell's harness mounts a
 * single-machine panel -- one machine renders no chips by design -- and a second machine there
 * means a second sidecar, two feeds and two rosters to stand up for a control whose whole job is
 * four labels and a toggle.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BotMachineChips } from "@/features/bots/BotMachineChips";

const MACHINES = [
  { key: "dev", label: "dev" },
  { key: "oracle", label: "oracle" },
];

afterEach(cleanup);

describe("BotMachineChips", () => {
  it("names every machine with the number of canvas Bots on it", () => {
    render(
      <BotMachineChips
        machines={MACHINES}
        hidden={new Set()}
        countOf={(key) => (key === "dev" ? 7 : 1)}
        onToggle={() => undefined}
      />,
    );
    const group = screen.getByRole("group", { name: "Machines on the canvas" });
    expect(group).toHaveTextContent("dev7");
    expect(group).toHaveTextContent("oracle1");
  });

  it("keeps a hidden machine's count, which is what pressing it would bring back", () => {
    render(
      <BotMachineChips
        machines={MACHINES}
        hidden={new Set(["oracle"])}
        countOf={(key) => (key === "dev" ? 7 : 1)}
        onToggle={() => undefined}
      />,
    );
    // The point of the count: a machine holding back six cards and one holding back none read
    // identically otherwise, and the second is the one a reader is hunting for.
    const oracle = screen.getByRole("button", { name: /oracle/ });
    expect(oracle).toHaveAttribute("aria-pressed", "false");
    expect(oracle).toHaveTextContent("1");
    expect(oracle).toHaveAttribute("title", "Show oracle's Bots on the canvas");
    expect(screen.getByRole("button", { name: /dev/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles by machine key rather than by label", () => {
    const onToggle = vi.fn();
    render(
      <BotMachineChips
        machines={[{ key: "peer-1", label: "oracle" }]}
        hidden={new Set()}
        countOf={() => 1}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /oracle/ }));
    expect(onToggle).toHaveBeenCalledWith("peer-1");
  });

  it("renders nothing at all on a single-machine panel", () => {
    // Which is every panel until a peer is declared. A lone chip could only tell a reader what they
    // already know, and could only turn everything off.
    const { container } = render(
      <BotMachineChips
        machines={[]}
        hidden={new Set()}
        countOf={() => 0}
        onToggle={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
