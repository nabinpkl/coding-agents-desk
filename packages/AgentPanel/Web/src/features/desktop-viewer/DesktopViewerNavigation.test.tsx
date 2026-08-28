import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { DesktopNavigationState } from "@agentdesk/agent-feed-wire";
import type { DesktopViewerSurface } from "./DesktopViewerSurface";
import { DesktopViewer } from "./DesktopViewer";

type SurfaceProps = ComponentProps<typeof DesktopViewerSurface>;
const harness = vi.hoisted(() => ({ surfaces: new Map<string, SurfaceProps>(), sends: vi.fn(), opens: [] as string[] }));
const displays = ["A", "B", "C"].map((id, index) => ({ id, label: `Monitor ${id}`, isMain: index === 0,
  activeSpaceId: String(index * 2 + 1), spaces: [0, 1].map((n) => ({ id: String(index * 2 + n + 1), type: 0 })) }));
function snapshot(id: string, revision = 1): DesktopNavigationState {
  return { type: "desktop-state", revision, captureDisplayId: id, displays };
}
vi.mock("./DesktopViewerSurface", async () => {
  const React = await import("react");
  return {
    desktopDocumentFallbackHeight: () => null,
    DesktopViewerSurface: (props: SurfaceProps) => {
      const id = props.displayId ?? "A";
      harness.surfaces.set(id, props);
      React.useEffect(() => {
        harness.opens.push(id);
        props.onSource?.({ width: 1000, height: 800, cursor: { x: 500, y: 400 },
          desktopControlVersion: 2, desktopNavigationVersion: 1, displayId: id });
        props.onTransport?.({ send: (input) => {
          harness.sends(input);
          if (input.type === "desktop-refresh") props.onEvent?.(snapshot(id));
          return "sent";
        } });
        props.onEvent?.(snapshot(id));
        if (props.displayId === undefined) props.onFirstFrame?.();
      }, []);
      return <div data-testid={`surface-${id}`} data-interactive={props.interactive} />;
    },
  };
});
beforeEach(() => {
  localStorage.clear(); harness.surfaces.clear(); harness.opens.length = 0; harness.sends.mockClear();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
function show() { return render(<DesktopViewer transport={{ request: vi.fn().mockResolvedValue({ status: 204, body: "" }), subscribe: vi.fn() }} />);
}
describe("monitor handover", () => {
  it("retains the old picture with input blocked until the matching new source presents a frame", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Monitor B" }));
    expect(screen.getByTestId("surface-A")).toHaveAttribute("data-interactive", "false");
    expect(screen.getByTestId("surface-B")).toHaveAttribute("data-interactive", "false");
    expect(screen.getByTestId("surface-A").parentElement).toHaveStyle({ opacity: "1" });
    expect(screen.getByTestId("surface-B").parentElement).toHaveStyle({ opacity: "0" });
    expect(harness.sends).toHaveBeenCalledWith({ type: "release-control" });
    act(() => harness.surfaces.get("B")!.onFirstFrame?.());
    expect(screen.queryByTestId("surface-A")).not.toBeInTheDocument();
    expect(screen.getByTestId("surface-B")).toHaveAttribute("data-interactive", "true");
    expect(screen.getByRole("button", { name: "Monitor B" })).toHaveAttribute("aria-pressed", "true");
  });
  it("ignores late frames and failures from a superseded monitor request", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Monitor B" }));
    const stale = harness.surfaces.get("B")!;
    fireEvent.click(screen.getByRole("button", { name: "Monitor C" }));
    act(() => { stale.onFirstFrame?.(); stale.onState?.({ kind: "error", message: "old error" }); });
    expect(screen.getByTestId("surface-A")).toBeInTheDocument();
    expect(screen.queryByTestId("surface-B")).not.toBeInTheDocument();
    expect(screen.queryByText("old error")).not.toBeInTheDocument();
    act(() => harness.surfaces.get("C")!.onFirstFrame?.());
    expect(screen.getByTestId("surface-C")).toHaveAttribute("data-interactive", "true");
  });
  it("rehomes an unplugged source with a notice, including the capture-death race", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Monitor B" }));
    act(() => harness.surfaces.get("B")!.onFirstFrame?.());
    act(() => harness.surfaces.get("B")!.onDisplayUnavailable?.("A"));
    expect(screen.getByTestId("surface-B")).toHaveAttribute("data-interactive", "false");
    act(() => harness.surfaces.get("A")!.onFirstFrame?.());
    expect(screen.getByText(/Monitor disconnected/)).toBeInTheDocument();
    expect(screen.getByTestId("surface-A")).toHaveAttribute("data-interactive", "true");
  });
  it("does not replace the capture for ordinary Desktop changes and hides navigation while typing", () => {
    show();
    act(() => harness.surfaces.get("A")!.onEvent?.({ ...snapshot("A", 2),
      displays: [{ ...displays[0], activeSpaceId: "2" }, ...displays.slice(1)] }));
    expect(harness.opens).toEqual(["A"]);
    act(() => harness.surfaces.get("A")!.onKeyboard?.(true));
    expect(screen.queryByTestId("desktop-navigation")).not.toBeInTheDocument();
  });
});
