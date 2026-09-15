/**
 * What the sidebar says when the dev server is sitting on a change.
 *
 * The rule the tests encode: at rest this is not on screen at all, and the moment it is, it says
 * both halves -- that the page is behind the tree, and why -- with the override beside them.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PanelBuildStatus } from "@/features/profile/PanelBuildStatus";
import type { PanelBuild } from "@/features/profile/panelBuild";

function build(overrides: Partial<PanelBuild> = {}): PanelBuild {
  return {
    id: "7373cec+",
    connected: true,
    held: [],
    blocked: null,
    checking: false,
    unfiltered: false,
    publish: () => {},
    ...overrides,
  };
}

describe("held work in the sidebar", () => {
  it("says nothing at all when the page is current", () => {
    const { container } = render(<PanelBuildStatus build={build()} />);
    expect(container.textContent).toBe("");
  });

  it("stays quiet on a page that has lost the server, where the build chip already warns", () => {
    const { container } = render(
      <PanelBuildStatus build={build({ connected: false, held: ["main.tsx"] })} />,
    );
    expect(container.textContent).toBe("");
  });

  it("counts what is held and names it", () => {
    render(<PanelBuildStatus build={build({ held: ["main.tsx", "panelBuild.ts"] })} />);
    expect(screen.getByText("2 changes held")).toBeDefined();
    expect(screen.getByText("main.tsx, panelBuild.ts")).toBeDefined();
  });

  it("separates deciding from refusing", () => {
    const { rerender } = render(<PanelBuildStatus build={build({ held: ["main.tsx"], checking: true })} />);
    expect(screen.getByText("1 change held, checking")).toBeDefined();

    rerender(
      <PanelBuildStatus
        build={build({ held: ["main.tsx"], blocked: "main.tsx(12,3): error TS2304: Cannot find name 'Foo'." })}
      />,
    );
    expect(screen.getByText("1 change held")).toBeDefined();
    expect(screen.getByText(/error TS2304/)).toBeDefined();
  });

  it("hands the override to whoever is sure the code is good", () => {
    const publish = vi.fn();
    render(<PanelBuildStatus build={build({ held: ["main.tsx"], blocked: "nope", publish })} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(publish).toHaveBeenCalledOnce();
  });

  // The state where the gate is gone: edits are arriving unjudged, which is worth knowing before
  // one of them takes the page down.
  it("says when nothing is gating updates at all", () => {
    render(<PanelBuildStatus build={build({ unfiltered: true })} />);
    expect(screen.getByText("No typechecker: edits arrive unfiltered.")).toBeDefined();
  });
});
