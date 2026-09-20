/**
 * The usage calendar, driven the way a reader reaches it: through the Profile menu.
 *
 * It lived in `ProfileRow.test.tsx` until the row grew a control of its own and the file grew past
 * the 500-line cap. Two ideas were in there, and this is the one about figures rather than menus.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "@agentdesk/agent-feed-wire";
import type { DesktopParkHandle } from "@/features/desktop-park/useDesktopPark";
import { ProfileRow } from "@/features/profile/ProfileRow";
import type { UsageHandle, UsageState } from "@/features/usage/useUsage";

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
            alias: null,
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
        sampledAt: TODAY,
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

/** The same report with a second vendor on it, which is what the modal's tabs are built from. */
function twoVendorReport(): UsageReport {
  const base = report();
  return {
    vendors: [base.vendors[0]!, {
      vendor: "claude",
      displayName: "Claude",
      installed: true,
      days: [{
        date: "2026-08-17",
        totals: {
          inputTokens: 28_245_702_083,
          cachedInputTokens: 27_795_005_326,
          outputTokens: 76_015_475,
          reasoningTokens: 11_871_275,
          requests: 105_365,
        },
        byModel: [{
          model: "claude-opus-5",
          alias: "opus 5",
          totals: {
            inputTokens: 28_245_702_083,
            cachedInputTokens: 27_795_005_326,
            outputTokens: 76_015_475,
            reasoningTokens: 11_871_275,
            requests: 105_365,
          },
        }],
      }],
      // Stamped against the wall clock, not the fixture's TODAY: the modal ages a quota against
      // the real `Date.now`, and a fixed stamp would make the assertion drift with the calendar.
      quota: {
        label: "5-hour limit",
        usedPercent: 92,
        // A reset already in the past, which is what a 45-hour-old reading has.
        resetsAt: Date.now() - 40 * 60 * 60 * 1000,
        windowMinutes: 300,
        planType: null,
        sampledAt: Date.now() - 45 * 60 * 60 * 1000,
      },
      coverage: { from: "2026-05-16", to: "2026-08-17", sessions: 1_388, unreadable: 0 },
      scannedAt: TODAY,
    }],
  };
}

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

  it("offers a tab per vendor and shows the one selected", () => {
    openModal(handle({ state: { kind: "ready", report: twoVendorReport(), settled: true } }));
    const tabs = screen.getByRole("tablist", { name: "Vendor" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent))
      .toEqual(["Codex", "Claude"]);
    expect(within(tabs).getByRole("tab", { name: "Codex" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(within(tabs).getByRole("tab", { name: "Claude" }));
    expect(within(tabs).getByRole("tab", { name: "Claude" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText(/1,388 sessions/)).toBeInTheDocument();
  });

  it("opens on a vendor that has records rather than on the first one listed", () => {
    // A machine with only Claude would otherwise open onto an empty Codex grid and read as a
    // feature that cannot see Claude at all.
    const oneVendor = twoVendorReport();
    oneVendor.vendors[0]!.installed = false;
    oneVendor.vendors[0]!.days = [];
    openModal(handle({ state: { kind: "ready", report: oneVendor, settled: true } }));
    const tabs = screen.getByRole("tablist", { name: "Vendor" });
    expect(within(tabs).getByRole("tab", { name: /Claude/ })).toHaveAttribute("aria-selected", "true");
    expect(within(tabs).getByRole("tab", { name: /Codex/ })).toHaveTextContent("not found");
  });

  it("forgets the hovered day when the tab changes", () => {
    // The readout points at a date the other vendor may have no record of. Left alone it would
    // fall back to that vendor's most recent day, which reads as the tab having ignored the click.
    openModal(handle({ state: { kind: "ready", report: twoVendorReport(), settled: true } }));
    fireEvent.mouseEnter(document.querySelector('[data-date="2026-08-13"]')!);
    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));
    expect(within(dayFigures()).getByText("28.25B")).toBeInTheDocument();
  });

  it("names a model by its short name and keeps the exact id", () => {
    openModal(handle({ state: { kind: "ready", report: twoVendorReport(), settled: true } }));
    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));
    const model = within(screen.getByRole("list", { name: "Models used" })).getByTitle("claude-opus-5");
    expect(model).toHaveTextContent("opus 5");
    expect(model).toHaveTextContent("claude-opus-5");
  });

  it("reports a stale quota by its age rather than by a reset that has passed", () => {
    // The Claude meter comes from a config cache the CLI refreshes on its own schedule, measured
    // 45 hours old on a machine that ran sessions throughout. "resets in now" would be a true
    // sentence about a reading nobody should act on.
    openModal(handle({ state: { kind: "ready", report: twoVendorReport(), settled: true } }));
    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));
    expect(screen.getByText("reading 1d old")).toBeInTheDocument();
    expect(screen.queryByText(/resets in/)).toBeNull();
  });

  it("tells an uninstalled vendor apart from one that ran nothing", () => {
    const empty = report();
    empty.vendors[0]!.installed = false;
    empty.vendors[0]!.days = [];
    openModal(handle({ state: { kind: "ready", report: empty, settled: true } }));
    expect(screen.getByText("No Codex records on this machine.")).toBeInTheDocument();
  });
});
