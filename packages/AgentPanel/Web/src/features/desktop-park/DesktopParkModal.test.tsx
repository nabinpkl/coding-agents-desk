import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ParkPlanResponse, ParkStateResponse } from "@agentdesk/agent-feed-wire";
import { DesktopParkPanel, groupByDesktop } from "./DesktopParkModal";
import type { DesktopParkHandle } from "./useDesktopPark";

const DISPLAY = { x: 0, y: 0, w: 1800, h: 1169 };

function state(overrides: Partial<ParkStateResponse> = {}): ParkStateResponse {
  return {
    yabaiPath: "/usr/local/bin/yabai",
    activeSpace: { index: 1, id: 3, display: 1 },
    displays: [{ index: 1, frame: DISPLAY }],
    stackingOrder: [11, 22],
    counts: { tracked: 4, parkable: 2, alreadyHere: 1, elsewhere: 1 },
    windows: [
      {
        id: 11, app: "ChatGPT", title: "Review latency", pid: 900, space: 1, display: 1,
        frame: { x: 100, y: 100, w: 600, h: 877 }, onActiveSpace: true, isVisible: true,
      },
      {
        id: 22, app: "Code", title: "evals", pid: 901, space: 4, display: 1,
        frame: { x: 20, y: 60, w: 900, h: 700 }, onActiveSpace: false, isVisible: false,
      },
    ],
    ...overrides,
  };
}

function plan(overrides: Partial<ParkPlanResponse> = {}): ParkPlanResponse {
  return {
    activeSpace: { index: 1, id: 3, display: 1 },
    display: { index: 1, frame: DISPLAY },
    options: { strip: 40, step: 24, topMargin: 39 },
    sound: true,
    overflow: [],
    starved: [],
    moves: [
      {
        id: 11, app: "ChatGPT", title: "Review latency", side: "right", depth: 0, rung: 0,
        from: { space: 1, x: 100, y: 100 }, to: { space: 1, x: 1760, y: 39 },
        exposedPt2: 35080, noop: false,
      },
      {
        id: 22, app: "Code", title: "evals", side: "left", depth: 1, rung: 0,
        from: { space: 4, x: 20, y: 60 }, to: { space: 1, x: -860, y: 39 },
        exposedPt2: 28000, noop: false,
      },
    ],
    ...overrides,
  };
}

function handle(overrides: Partial<DesktopParkHandle> = {}): DesktopParkHandle {
  return {
    available: true,
    view: { kind: "ready", state: state(), plan: plan() },
    action: { kind: "none" },
    load: () => {},
    park: () => {},
    restore: () => {},
    busy: false,
    ...overrides,
  };
}

describe("groupByDesktop", () => {
  it("puts the active Desktop first and the rest in index order", () => {
    const groups = groupByDesktop(
      state({
        activeSpace: { index: 4, id: 7, display: 1 },
        windows: [
          { ...state().windows[0]!, space: 6 },
          { ...state().windows[1]!, space: 4 },
        ],
      }),
    );
    expect(groups.map((g) => g.space)).toEqual([4, 6]);
    expect(groups[0]!.active).toBe(true);
  });

  it("returns nothing when there is no state yet, rather than an empty Desktop", () => {
    expect(groupByDesktop(undefined)).toEqual([]);
  });
});

describe("the Desktop park view", () => {
  it("groups windows under the Desktop they are on now", () => {
    render(<DesktopParkPanel park={handle()} onClose={() => {}} />);
    const active = screen.getByRole("heading", { name: /Desktop 1/ });
    expect(within(active).getByText("active")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Desktop 4/ })).toBeInTheDocument();
    expect(screen.getByText("Review latency")).toBeInTheDocument();
  });

  it("shows where each window would land, so the move is legible before it happens", () => {
    render(<DesktopParkPanel park={handle()} onClose={() => {}} />);
    expect(screen.getByText("1760,39")).toBeInTheDocument();
    expect(screen.getByText("-860,39")).toBeInTheDocument();
  });

  it("refuses to park a plan that would starve a window", () => {
    const park = handle({
      view: { kind: "ready", state: state(), plan: plan({ sound: false, starved: [22] }) },
    });
    render(<DesktopParkPanel park={park} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /^Park/ })).toBeDisabled();
    expect(screen.getByText(/stops rendering/)).toBeInTheDocument();
  });

  it("parks on demand and never on render", () => {
    const onPark = vi.fn();
    render(<DesktopParkPanel park={handle({ park: onPark })} onClose={() => {}} />);
    expect(onPark).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Park/ }));
    expect(onPark).toHaveBeenCalledOnce();
  });

  it("disables both actions while one is running", () => {
    const park = handle({ busy: true, action: { kind: "running", what: "park" } });
    render(<DesktopParkPanel park={park} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /Working/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Restore/ })).toBeDisabled();
  });

  it("says when the gather changed the stacking order the ladder was laid against", () => {
    const park = handle({
      action: {
        kind: "parked",
        report: {
          targetSpace: { index: 1, uuid: "u" },
          candidates: 2,
          gathered: [{ id: 11, app: "ChatGPT", ok: true }],
          orderBeforeGather: [11, 22],
          observedOrder: [22, 11],
          laid: [{ id: 11, app: "ChatGPT", ok: true }],
          sound: true,
          manifestPath: "/tmp/m.json",
          dryRun: false,
        },
      },
    });
    render(<DesktopParkPanel park={park} onClose={() => {}} />);
    expect(screen.getByText(/stacking order changed during the gather/)).toBeInTheDocument();
  });

  it("reports a restore by outcome rather than claiming everything came back", () => {
    const park = handle({
      action: {
        kind: "restored",
        report: {
          found: true,
          parkedAt: 1,
          results: [
            { windowID: 11, app: "ChatGPT", outcome: "restored" },
            { windowID: 22, app: "Code", outcome: "orphaned", detail: "no window with this id" },
          ],
          manifestCleared: true,
        },
      },
    });
    render(<DesktopParkPanel park={park} onClose={() => {}} />);
    expect(screen.getByText(/1 restored/)).toBeInTheDocument();
    expect(screen.getByText(/1 orphaned/)).toBeInTheDocument();
  });

  it("surfaces a sidecar failure instead of looking like it worked", () => {
    const park = handle({ view: { kind: "error", message: "no yabai binary found" } });
    render(<DesktopParkPanel park={park} onClose={() => {}} />);
    expect(screen.getByText("no yabai binary found")).toBeInTheDocument();
  });

  it("offers the whole desktop as a watchable source", () => {
    render(<DesktopParkPanel park={handle()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Watch desktop" }));
    // The tile section opens naming the display, and the toggle inverts.
    expect(screen.getByText(/the active Space/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop desktop" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop desktop" }));
    expect(screen.queryByText(/the active Space/)).not.toBeInTheDocument();
  });
});
