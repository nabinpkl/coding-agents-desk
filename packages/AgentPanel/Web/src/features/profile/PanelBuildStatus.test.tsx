/**
 * What the sidebar says when the dev server is sitting on a change.
 *
 * The rule the tests encode: at rest this is not on screen at all, and the moment it is, it says
 * both halves -- that the page is behind the tree, and why.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PanelBuildStatus } from "@/features/profile/PanelBuildStatus";
import type { PanelBuild } from "@/features/profile/panelBuild";

function build(overrides: Partial<PanelBuild> = {}): PanelBuild {
  return {
    id: "7373cec+",
    connected: true,
    held: [],
    blocked: null,
    sidecar: null,
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

  it("counts what is held and says why", () => {
    render(
      <PanelBuildStatus
        build={build({
          held: ["main.tsx", "panelBuild.ts"],
          blocked: "main.tsx: Unexpected end of file (line 12)",
        })}
      />,
    );
    expect(screen.getByText("2 files held back")).toBeDefined();
    expect(screen.getByText(/Unexpected end of file/)).toBeDefined();
  });

  it("falls back to the names when the reason did not survive the wire", () => {
    render(<PanelBuildStatus build={build({ held: ["main.tsx"] })} />);
    expect(screen.getByText("1 file held back")).toBeDefined();
    expect(screen.getByText("main.tsx")).toBeDefined();
  });

  // The other process, on the same row. The sidecar runs the working tree too, and a reader looking
  // at a feed with no new rows cannot otherwise tell it apart from a session that has gone quiet.
  it("says when the sidecar's own supervisor is holding the tree back", () => {
    render(
      <PanelBuildStatus
        build={build({ sidecar: { held: true, blocked: "sessionRoutes.ts: Syntax Error" } })}
      />,
    );
    expect(screen.getByText("Sidecar held back")).toBeDefined();
    expect(screen.getByText(/sessionRoutes.ts/)).toBeDefined();
  });

  it("stays quiet about a sidecar that is merely running", () => {
    const { container } = render(
      <PanelBuildStatus build={build({ sidecar: { held: false, blocked: null } })} />,
    );
    expect(container.textContent).toBe("");
  });

  it("shows both halves when both are behind", () => {
    render(
      <PanelBuildStatus
        build={build({ held: ["main.tsx"], sidecar: { held: true, blocked: null } })}
      />,
    );
    expect(screen.getByText("1 file held back")).toBeDefined();
    expect(screen.getByText("Sidecar held back")).toBeDefined();
  });
});
