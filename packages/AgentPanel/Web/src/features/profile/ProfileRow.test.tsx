import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "@agentdesk/agent-feed-wire";
import type { DesktopParkHandle } from "../desktop-park/useDesktopPark";
import { ProfileRow } from "./ProfileRow";
import type { UsageHandle, UsageState } from "../usage/useUsage";

/** jsdom has no dialog implementation; the modal drives `showModal` and `close`. */
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  });
});

const TODAY = new Date(2026, 7, 19, 12).getTime();

function report(): UsageReport {
  return {
    vendors: [{
      vendor: "codex",
      displayName: "Codex",
      installed: true,
      days: [
        {
          date: "2026-08-13",
          // The real proportions: 98% of input served from cache. A fixture with a plausible-
          // looking 50% would let a broken split render as if it were right.
          totals: {
            inputTokens: 485_224_170,
            cachedInputTokens: 476_362_112,
            outputTokens: 1_334_902,
            reasoningTokens: 486_208,
            requests: 3_291,
          },
          byModel: [{
            model: "gpt-5.6-sol",
            totals: {
              inputTokens: 485_224_170,
              cachedInputTokens: 476_362_112,
              outputTokens: 1_334_902,
              reasoningTokens: 486_208,
              requests: 3_291,
            },
          }],
        },
        {
          date: "2026-08-18",
          totals: {
            inputTokens: 4_000_000,
            cachedInputTokens: 1_000_000,
            outputTokens: 40_000,
            reasoningTokens: 10_000,
            requests: 100,
          },
          byModel: [],
        },
      ],
      quota: {
        label: "Weekly limit",
        usedPercent: 13,
        windowMinutes: 10_080,
        resetsAt: TODAY + 2 * 24 * 60 * 60 * 1000,
        planType: "prolite",
      },
      coverage: { from: "2026-08-01", to: "2026-08-18", sessions: 977, unreadable: 0 },
      scannedAt: TODAY,
    }],
  };
}

function handle(overrides: Partial<UsageHandle> = {}): UsageHandle {
  return {
    vendors: ["codex"],
    state: { kind: "ready", report: report(), settled: true } as UsageState,
    load: vi.fn(),
    ...overrides,
  };
}

/** The whole day panel, hint and figures alike. */
function dayDetail(): HTMLElement {
  return screen.getByRole("group", { name: "Selected day" });
}

/** Just the day's own figures, not the week lines under them. */
function dayFigures(): HTMLElement {
  return dayDetail().querySelector("dl")!;
}

/**
 * A Desktop-park handle that is present but has nothing to offer, which is the
 * state these tests care about: the entry exists, the usage assertions below are
 * unaffected by it.
 */
function parkHandle(overrides: Partial<DesktopParkHandle> = {}): DesktopParkHandle {
  return {
    available: false,
    view: { kind: "idle" },
    action: { kind: "none" },
    load: () => {},
    park: () => {},
    restore: () => {},
    busy: false,
    ...overrides,
  };
}

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: /^Profile/ }));
}

describe("the profile row", () => {
  it("opens its menu upward, out of the row it belongs to", () => {
    render(<ProfileRow usage={handle()} park={parkHandle()} />);
    openMenu();
    const menu = screen.getByRole("menu", { name: "Profile" });
    // `bottom-full` is what makes it open upward, with no measurement and nothing to clip it. It
    // is inside the row's own subtree so the hover-preview sidebar, which dismisses on
    // `pointerleave` of its `<aside>`, does not vanish when the pointer moves into the menu.
    expect(menu.className).toContain("bottom-full");
    expect(screen.getByRole("button", { name: /^Profile/ }).parentElement).toContainElement(menu);
  });

  it("says the trigger is a menu, and whether it is open", () => {
    render(<ProfileRow usage={handle()} park={parkHandle()} />);
    const trigger = screen.getByRole("button", { name: /^Profile/ });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    openMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    render(<ProfileRow usage={handle()} park={parkHandle()} />);
    openMenu();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Profile/ }));
  });

  it("closes when something outside it is pressed", () => {
    render(<ProfileRow usage={handle()} park={parkHandle()} />);
    openMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers Usage as unavailable rather than hiding the machine has none", () => {
    render(<ProfileRow usage={handle({ vendors: [], state: { kind: "idle" } })} park={parkHandle()} />);
    openMenu();
    const item = screen.getByRole("menuitem", { name: /Usage/ });
    expect(item).toBeDisabled();
    expect(screen.getByText("No agent vendors detected")).toBeInTheDocument();
  });

  it("shows the quota on the row itself, once a report has arrived", () => {
    render(<ProfileRow usage={handle()} park={parkHandle()} />);
    expect(screen.getByRole("button", { name: /^Profile/ })).toHaveTextContent("13%");
  });

  it("sweeps only when Usage is pressed", () => {
    const usage = handle();
    render(<ProfileRow usage={usage} park={parkHandle()} />);
    openMenu();
    expect(usage.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: /Usage/ }));
    expect(usage.load).toHaveBeenCalledTimes(1);
  });
});

describe("the usage modal", () => {
  function openModal(usage: UsageHandle = handle()) {
    const rendered = render(<ProfileRow usage={usage} park={parkHandle()} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Usage/ }));
    return rendered;
  }

  it("shows a day's input, cached and uncached totals when it is hovered", () => {
    openModal();
    fireEvent.mouseEnter(document.querySelector('[data-date="2026-08-13"]')!);

    // The three numbers the feature exists for. 485.22M sent, of which 476.36M came from cache,
    // leaving 8.86M that did not: reading only the first would be reading mostly cache traffic.
    // Read from the day's own figures, not the week lines below them.
    const readout = within(dayFigures());
    expect(readout.getByText("485.22M")).toBeInTheDocument();
    expect(readout.getByText("cached (98.2%)")).toBeInTheDocument();
    expect(readout.getByText("476.36M")).toBeInTheDocument();
    expect(readout.getByText("8.86M")).toBeInTheDocument();
    expect(readout.getByText("3,291")).toBeInTheDocument();
  });

  it("opens on the most recent recorded day rather than on nothing", () => {
    // Both because it is the more useful thing to open on, and because it is what keeps the panel
    // from being a reserved rectangle of empty space in its resting state.
    openModal();
    expect(within(dayDetail()).getByText("Tue, Aug 18, 2026")).toBeInTheDocument();
    expect(document.querySelector('[data-date="2026-08-18"]')).toHaveAttribute("aria-selected", "true");
  });

  it("falls back to that day when the pointer leaves the grid", () => {
    openModal();
    fireEvent.mouseEnter(document.querySelector('[data-date="2026-08-13"]')!);
    expect(within(dayDetail()).getByText("Thu, Aug 13, 2026")).toBeInTheDocument();
    fireEvent.mouseLeave(document.querySelector("[role='grid']")!);
    expect(within(dayDetail()).getByText("Tue, Aug 18, 2026")).toBeInTheDocument();
  });

  it("puts the same numbers on the cell for a screen reader", () => {
    openModal();
    const cell = document.querySelector('[data-date="2026-08-13"]')!;
    expect(cell.getAttribute("aria-label")).toContain("476.36M cached (98.2%)");
    expect(cell.getAttribute("aria-label")).toContain("8.86M uncached");
  });

  it("says so when a covered day ran nothing", () => {
    openModal();
    const cell = document.querySelector('[data-date="2026-08-14"]')!;
    expect(cell.getAttribute("aria-label")).toContain("no usage");
  });

  it("distinguishes a day the history does not reach", () => {
    openModal();
    const cell = document.querySelector('[data-date="2026-07-20"]')!;
    expect(cell.getAttribute("aria-label")).toContain("outside the recorded history");
  });

  it("compares the hovered day's week with the one before it", () => {
    openModal();
    fireEvent.mouseEnter(document.querySelector('[data-date="2026-08-18"]')!);
    // 2026-08-18 is in the week of the 17th, which holds 4M; the week before holds the 13th's
    // 485.22M. The comparison is stated and left there; the panel draws no conclusion from it.
    const weeks = screen.getByText("that week").parentElement!;
    expect(weeks).toHaveTextContent("4.00M");
    expect(weeks).toHaveTextContent("485.22M");
  });

  it("holds one shape whether or not a day is showing, so the grid cannot move", () => {
    // jsdom has no layout, so this asserts the structure that produces the stable height rather
    // than the height itself: the same element tree either way, and a model list that reserves its
    // rows. Measured in a browser before this was fixed, hovering moved the grid up 8px and moving
    // to a two-model day moved it another 10px -- under a pointer aimed at a 12px square.
    const shapeOf = () => {
      const detail = dayDetail();
      return {
        figures: detail.querySelectorAll("dl")[0]!.children.length,
        weekRows: detail.querySelectorAll("dl")[1]!.children.length,
        modelList: detail.querySelector("ul")!.getAttribute("style"),
      };
    };

    openModal();
    const resting = shapeOf();
    fireEvent.mouseEnter(document.querySelector('[data-date="2026-08-13"]')!);
    const oneModel = shapeOf();
    fireEvent.mouseEnter(document.querySelector('[data-date="2026-08-18"]')!);
    const noModels = shapeOf();

    expect(oneModel).toEqual(resting);
    expect(noModels).toEqual(resting);
    // Three 1.25rem rows plus two 0.25rem gaps, whether the day fills them or not.
    expect(resting.modelList).toContain("4.25rem");
  });

  it("keeps the grid to one tab stop", () => {
    openModal();
    const cells = Array.from(document.querySelectorAll("[role='gridcell']"));
    expect(cells.length).toBeGreaterThan(100);
    expect(cells.filter((cell) => cell.getAttribute("tabindex") === "0")).toHaveLength(1);
  });

  it("moves a week per left-arrow press", () => {
    openModal();
    const cell = document.querySelector('[data-date="2026-08-18"]')!;
    fireEvent.click(cell);
    fireEvent.keyDown(cell, { key: "ArrowLeft" });
    expect(document.querySelector('[data-date="2026-08-11"]')).toHaveAttribute("tabindex", "0");
  });

  it("names the vendor and what the scan covered", () => {
    openModal();
    const dialog = screen.getByRole("dialog", { name: "Token usage" });
    expect(within(dialog).getByText("Codex")).toBeInTheDocument();
    expect(within(dialog).getByText(/977 sessions/)).toBeInTheDocument();
  });

  it("reports unreadable session files rather than swallowing them", () => {
    const broken = report();
    broken.vendors[0]!.coverage.unreadable = 3;
    openModal(handle({ state: { kind: "ready", report: broken, settled: true } }));
    expect(screen.getByText(/3 unreadable/)).toBeInTheDocument();
  });

  it("draws the whole panel while the first sweep runs, withholding only the figures", () => {
    // Not a spinner and not a different layout: a cold sweep reads gigabytes and takes seconds,
    // and the grid, the readout and the footer are all at their final size throughout, so the
    // report landing moves nothing. Verified in a browser at 472px tall before and after.
    openModal(handle({ state: { kind: "loading" } }));
    const dialog = screen.getByRole("dialog", { name: "Token usage" });
    expect(within(dialog).getAllByText("—").length).toBeGreaterThan(0);
    expect(dialog.querySelector("[role='grid']")).toBeInTheDocument();
    expect(within(dialog).getByText("Reading session records…")).toBeInTheDocument();
    // Withheld, not invented: a zero would read as a real range in which nothing ran.
    expect(within(screen.getByLabelText(/^Last \d+ weeks$/)).queryByText("0")).toBeNull();
  });

  it("says a sweep failed instead of showing an empty calendar", () => {
    openModal(handle({ state: { kind: "error", message: "disk went away" } }));
    expect(screen.getByText(/disk went away/)).toBeInTheDocument();
  });

  it("tells an uninstalled vendor apart from one that ran nothing", () => {
    const empty = report();
    empty.vendors[0]!.installed = false;
    empty.vendors[0]!.days = [];
    openModal(handle({ state: { kind: "ready", report: empty, settled: true } }));
    expect(screen.getByText("No Codex records on this machine.")).toBeInTheDocument();
  });
});
