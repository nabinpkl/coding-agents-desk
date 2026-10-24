/**
 * What the sidebar says when the dev server is sitting on a change.
 *
 * The rule the tests encode: at rest this is not on screen at all, and the moment it is, it says
 * both halves -- that the page is behind the tree, and why.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PanelBuildStatus } from "@/features/profile/PanelBuildStatus";
import type { PanelBuild } from "@/features/profile/panelBuild";

function build(overrides: Partial<PanelBuild> = {}): PanelBuild {
  return {
    id: "2cff18c+",
    connected: true,
    live: true,
    mode: "auto",
    held: [],
    blocked: null,
    sidecars: [],
    setMode: vi.fn(),
    apply: vi.fn(),
    restartSidecars: vi.fn(),
    ...overrides,
  };
}

describe("held work in the sidebar", () => {
  it("says nothing at all when the page is current", () => {
    const { container } = render(<PanelBuildStatus build={build()} />);
    expect(container.textContent).toBe("");
  });

  it("stays quiet on a page that has lost the server, where the build chip already warns", () => {
    const { container } = render(<PanelBuildStatus build={build({ connected: false, held: ["main.tsx"] })} />);
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
  it("names the machine whose supervisor is holding its tree back", () => {
    render(
      <PanelBuildStatus
        build={build({
          sidecars: [
            { machine: "oracle", held: true, blocked: "sessionRoutes.ts: Syntax Error", mode: "auto", behind: false },
          ],
        })}
      />,
    );
    expect(screen.getByText("oracle sidecar held back")).toBeDefined();
    expect(screen.getByText(/sessionRoutes.ts/)).toBeDefined();
  });

  // The panel reads more than one machine, and a held peer is invisible from a feed that has simply
  // stopped producing rows.
  it("says it once per machine", () => {
    render(
      <PanelBuildStatus
        build={build({
          sidecars: [
            { machine: "dev", held: true, blocked: null, mode: "auto", behind: false },
            { machine: "oracle", held: true, blocked: "half a file", mode: "auto", behind: false },
          ],
        })}
      />,
    );
    expect(screen.getByText("dev sidecar held back")).toBeDefined();
    expect(screen.getByText("oracle sidecar held back")).toBeDefined();
  });

  it("shows both halves when the panel and a sidecar are both behind", () => {
    render(
      <PanelBuildStatus
        build={build({
          held: ["main.tsx"],
          sidecars: [{ machine: "oracle", held: true, blocked: null, mode: "auto", behind: false }],
        })}
      />,
    );
    expect(screen.getByText("1 file held back")).toBeDefined();
    expect(screen.getByText("oracle sidecar held back")).toBeDefined();
  });
});

// Manual mode is the case with a decision in it. A whole file is held because the reader asked for
// it to be, so unlike a broken one there is something they can do about it, and unlike auto there
// is something they need telling.
describe("updates the reader is holding", () => {
  it("says which mode is in force even with nothing waiting", () => {
    // The hour-later case: a panel that stopped updating because somebody asked it to is
    // indistinguishable from a broken one unless it says so.
    render(<PanelBuildStatus build={build({ mode: "manual" })} />);
    expect(screen.getByText("updates manual")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("counts what is waiting and offers to take it", () => {
    const apply = vi.fn();
    render(<PanelBuildStatus build={build({ mode: "manual", held: ["main.tsx", "panelBuild.ts"], apply })} />);
    expect(screen.getByText("2 files waiting")).toBeDefined();
    // Nothing is wrong with them, so the line under it is the queue itself.
    expect(screen.getByText("main.tsx, panelBuild.ts")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("refuses to apply while one of them is half a file, and says which", () => {
    // Applying reloads, and a reload onto a half-written file is the broken page the whole gate
    // exists to prevent.
    render(
      <PanelBuildStatus
        build={build({
          mode: "manual",
          held: ["main.tsx"],
          blocked: "main.tsx: Unexpected end of file (line 12)",
        })}
      />,
    );
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    expect(apply.title).toContain("Unexpected end of file");
  });

  it("leaves the automatic wording alone, where there is nothing to decide", () => {
    render(<PanelBuildStatus build={build({ held: ["main.tsx"], blocked: "main.tsx: Syntax Error" })} />);
    expect(screen.getByText("1 file held back")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });
});

// A machine has two ways of being behind and only one of them is the reader's doing. Its own mode
// decides which, because a supervisor that restarted comes back on auto whatever this panel asked.
describe("what a machine is waiting for", () => {
  it("says a held machine is waiting when it is the reader it waits on", () => {
    render(
      <PanelBuildStatus
        build={build({
          mode: "manual",
          sidecars: [{ machine: "oracle", held: true, blocked: null, mode: "manual", behind: false }],
        })}
      />,
    );
    expect(screen.getByText("oracle sidecar waiting")).toBeDefined();
    expect(screen.getByText("its tree moved; Restart takes it")).toBeDefined();
  });

  it("still says held back when the machine is stuck on half a file", () => {
    render(
      <PanelBuildStatus
        build={build({
          mode: "manual",
          sidecars: [
            { machine: "oracle", held: true, blocked: "sessionRoutes.ts: Syntax Error", mode: "manual", behind: false },
          ],
        })}
      />,
    );
    expect(screen.getByText("oracle sidecar held back")).toBeDefined();
    expect(screen.getByText(/Syntax Error/)).toBeDefined();
  });

  // The drift case: this panel is holding everything, that machine came back on auto and is
  // restarting its sidecar again. Saying "waiting" there would be a claim about a thing not true.
  it("does not call a machine waiting when it is not the one waiting", () => {
    render(
      <PanelBuildStatus
        build={build({
          mode: "manual",
          sidecars: [{ machine: "oracle", held: true, blocked: null, mode: "auto", behind: false }],
        })}
      />,
    );
    expect(screen.getByText("oracle sidecar held back")).toBeDefined();
  });

  // A restart drops every stream from the sidecars, so it never rides along with a panel reload.
  // It takes every waiting machine at once: the Mac and a peer run one tree between them.
  it("restarts every waiting sidecar with one button, apart from the panel's Apply", () => {
    const apply = vi.fn();
    const restartSidecars = vi.fn();
    render(
      <PanelBuildStatus
        build={build({
          mode: "manual",
          held: ["main.tsx"],
          apply,
          restartSidecars,
          sidecars: [
            { machine: "mac", held: true, blocked: null, mode: "manual", behind: true },
            { machine: "oracle", held: true, blocked: null, mode: "manual", behind: true },
          ],
        })}
      />,
    );
    const restart = screen.getByRole("button", { name: "Restart sidecars" });
    expect(screen.getAllByRole("button", { name: "Restart sidecars" })).toHaveLength(1);
    expect(restart.title).toContain("mac and oracle sidecars");
    fireEvent.click(restart);
    expect(restartSidecars).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(restartSidecars).toHaveBeenCalledTimes(1);
  });

  it("offers no panel Apply when only a sidecar is waiting", () => {
    render(
      <PanelBuildStatus
        build={build({
          mode: "manual",
          sidecars: [{ machine: "oracle", held: true, blocked: null, mode: "manual", behind: true }],
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Restart sidecars" })).toBeEnabled();
  });

  it("says a machine is behind when it runs older code with nothing newer to restart onto", () => {
    render(
      <PanelBuildStatus
        build={build({
          mode: "manual",
          sidecars: [{ machine: "oracle", held: false, blocked: null, mode: "manual", behind: true }],
        })}
      />,
    );
    expect(screen.getByText("oracle sidecar behind")).toBeDefined();
    expect(screen.getByText("older code than this Mac, and no newer files arrived; check its ship job")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Restart sidecars" })).toBeNull();
  });

  it("offers no restart when the only held machine is stuck on half a file", () => {
    render(
      <PanelBuildStatus
        build={build({
          mode: "manual",
          sidecars: [
            { machine: "oracle", held: true, blocked: "sessionRoutes.ts: Syntax Error", mode: "manual", behind: true },
          ],
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Restart sidecars" })).toBeNull();
  });
});
