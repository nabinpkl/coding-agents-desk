/**
 * What a thrown render costs the reader.
 *
 * The defect this covers is the absence of anything at all: with no boundary in the tree React
 * unmounts every surface and the page goes white, so the tests assert that something legible is
 * still on screen and that it goes away again on its own once the code behind it is fixed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PanelErrorBoundary } from "@/app/PanelErrorBoundary";

/** A hot context that records its listeners, so a test can fire an update the way Vite would. */
function fakeDevServer() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    on: (event: string, listener: () => void) => {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(listener);
    },
    off: (event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener);
    },
    emit: (event: string) => {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
    count: (event: string) => listeners.get(event)?.size ?? 0,
  };
}

/** Throws until `broken` is flipped, which is how a fix arriving is spelled here. */
function Surface({ broken }: { broken: { value: boolean } }) {
  if (broken.value) throw new Error("Cannot read properties of undefined (reading 'blocks')");
  return <p>the feed</p>;
}

beforeEach(() => {
  // React writes the caught error to the console itself, and so does the boundary. Neither is the
  // thing under test, and both make a passing run look like a failing one.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a surface that throws while rendering", () => {
  it("leaves the children alone when nothing throws", () => {
    render(
      <PanelErrorBoundary surface="panel">
        <Surface broken={{ value: false }} />
      </PanelErrorBoundary>,
    );
    expect(screen.getByText("the feed")).toBeDefined();
  });

  it("says which surface stopped and what it said, rather than showing nothing", () => {
    render(
      <PanelErrorBoundary surface="desktop viewer">
        <Surface broken={{ value: true }} />
      </PanelErrorBoundary>,
    );
    expect(screen.getByText(/desktop viewer stopped rendering/)).toBeDefined();
    expect(screen.getByText(/reading 'blocks'/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Reload" })).toBeDefined();
  });

  it("mounts the children again when the reader asks, and stays up when they work", () => {
    const broken = { value: true };
    render(
      <PanelErrorBoundary surface="panel">
        <Surface broken={broken} />
      </PanelErrorBoundary>,
    );
    broken.value = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("the feed")).toBeDefined();
    expect(screen.queryByText(/stopped rendering/)).toBeNull();
  });

  // The failure is temporal: the tree was broken for as long as it took the next save to land, and
  // a boundary that waits to be clicked holds a dead screen long after the code behind it is fine.
  it("clears itself when the dev server applies an update", () => {
    const devServer = fakeDevServer();
    const broken = { value: true };
    const { unmount } = render(
      <PanelErrorBoundary surface="panel" devServer={devServer}>
        <Surface broken={broken} />
      </PanelErrorBoundary>,
    );
    expect(screen.getByText(/stopped rendering/)).toBeDefined();
    expect(screen.getByText("Clears itself on the next update.")).toBeDefined();

    broken.value = false;
    act(() => devServer.emit("vite:afterUpdate"));
    expect(screen.getByText("the feed")).toBeDefined();

    unmount();
    expect(devServer.count("vite:afterUpdate")).toBe(0);
  });

  it("promises no healing in a build with no dev server behind it", () => {
    render(
      <PanelErrorBoundary surface="panel" devServer={undefined}>
        <Surface broken={{ value: true }} />
      </PanelErrorBoundary>,
    );
    expect(screen.queryByText("Clears itself on the next update.")).toBeNull();
  });
});
