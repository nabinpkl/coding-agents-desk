import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "@agentdesk/agent-feed-wire";
import type { DesktopParkHandle } from "@/features/desktop-park/useDesktopPark";
import type { StaleSessionsHandle } from "@/features/profile/useStaleSessions";
import { ProfileRow } from "@/features/profile/ProfileRow";
import type { UsageHandle } from "@/features/usage/useUsage";

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
    vendors: [
      {
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
            byModel: [
              {
                model: "gpt-5.6-sol",
                alias: null,
                totals: {
                  inputTokens: 485_224_170,
                  cachedInputTokens: 476_362_112,
                  outputTokens: 1_334_902,
                  reasoningTokens: 486_208,
                  requests: 3_291,
                },
              },
            ],
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
        quotas: [
          {
            label: "Weekly limit",
            usedPercent: 13,
            windowMinutes: 10_080,
            resetsAt: TODAY + 2 * 24 * 60 * 60 * 1000,
            scope: null,
            planType: "prolite",
            sampledAt: TODAY,
          },
        ],
        coverage: { from: "2026-08-01", to: "2026-08-18", sessions: 977, unreadable: 0 },
        scannedAt: TODAY,
      },
    ],
  };
}

function handle(overrides: Partial<UsageHandle> = {}): UsageHandle {
  return {
    vendors: ["codex"],
    state: { kind: "ready", report: report(), settled: true },
    load: vi.fn(),
    ...overrides,
  };
}

/**
 * A Desktop-park handle that is present but has nothing to offer, which is the
 * state these tests care about: the entry exists, the usage assertions below are
 * unaffected by it.
 */
function restartsHandle(overrides: Partial<StaleSessionsHandle> = {}): StaleSessionsHandle {
  return { machines: [], load: () => {}, restart: () => {}, ...overrides };
}

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

/**
 * A stand-in for Vite's HMR client, which is what makes this page a live one.
 *
 * `import.meta.hot` cannot be stood up under Vitest -- its own is a partial context with no `off`,
 * which reads as no dev server at all -- so the live half of the row is reachable only through the
 * prop.
 */
function devServer() {
  return { on: () => {}, off: () => {} };
}

/** Answers the build route, and records what was asked of it. */
function serveBuild(mode: "auto" | "manual" = "auto") {
  const asked: { url: string; method: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ build: "2cff18c+", mode, held: [], blocked: null, sidecars: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { asked };
}

describe("the profile row", () => {
  it("opens its menu upward, out of the row it belongs to", () => {
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle()} />);
    openMenu();
    const menu = screen.getByRole("menu", { name: "Profile" });
    // `bottom-full` is what makes it open upward, with no measurement and nothing to clip it. It
    // is inside the row's own subtree so the hover-preview sidebar, which dismisses on
    // `pointerleave` of its `<aside>`, does not vanish when the pointer moves into the menu.
    expect(menu.className).toContain("bottom-full");
    expect(screen.getByRole("button", { name: /^Profile/ }).parentElement).toContainElement(menu);
  });

  it("says the trigger is a menu, and whether it is open", () => {
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle()} />);
    const trigger = screen.getByRole("button", { name: /^Profile/ });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    openMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle()} />);
    openMenu();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Profile/ }));
  });

  it("reads the stale sessions when that entry is chosen, and closes the menu over it", () => {
    const load = vi.fn();
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle({ load })} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Restart stale sessions" }));
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes when something outside it is pressed", () => {
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle()} />);
    openMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers Usage as unavailable rather than hiding the machine has none", () => {
    render(
      <ProfileRow
        usage={handle({ vendors: [], state: { kind: "idle" } })}
        park={parkHandle()}
        restarts={restartsHandle()}
      />,
    );
    openMenu();
    const item = screen.getByRole("menuitem", { name: /Usage/ });
    expect(item).toBeDisabled();
    expect(screen.getByText("No agent vendors detected")).toBeInTheDocument();
  });

  it("shows the quota on the row itself, once a report has arrived", () => {
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle()} />);
    expect(screen.getByRole("button", { name: /^Profile/ })).toHaveTextContent("13%");
  });

  it("sweeps only when Usage is pressed", () => {
    const usage = handle();
    render(<ProfileRow usage={usage} park={parkHandle()} restarts={restartsHandle()} />);
    openMenu();
    expect(usage.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: /Usage/ }));
    expect(usage.load).toHaveBeenCalledTimes(1);
  });
});

describe("build identity", () => {
  it("names the code this tab is running, on the row itself", () => {
    // The failure it exists for: a tab sitting on a bundle older than the tree answers questions
    // about code that has already been replaced, and nothing on screen says so.
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle()} />);

    expect(screen.getByLabelText(/^Panel build /).textContent).toBe("unknown");
  });
});

// The one control in this menu that changes how the panel BEHAVES rather than opening something.
describe("live updates", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is not offered at all in a build with no dev server behind it", () => {
    // A bundled panel receives no updates, so the question does not arise there. That is different
    // from Desktop park, which is disabled rather than hidden because the machine might gain yabai.
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle()} />);
    openMenu();
    expect(screen.queryByRole("menuitemcheckbox", { name: /Live updates/ })).toBeNull();
  });

  it("says which way it is set, as a control that is on rather than a label", async () => {
    serveBuild("auto");
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle()} devServer={devServer()} />);
    openMenu();
    const toggle = await screen.findByRole("menuitemcheckbox", { name: /Live updates/ });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(within(toggle).getByText("auto")).toBeDefined();
  });

  it("asks the dev server to hold them, since there is nowhere else the decision can be made", async () => {
    const { asked } = serveBuild("auto");
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle()} devServer={devServer()} />);
    openMenu();
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Live updates/ }));
    await waitFor(() => expect(asked.at(-1)?.method).toBe("POST"));
    expect(asked.at(-1)?.url).toContain("manual");
  });

  it("stays open, because a setting is not a thing you press once", async () => {
    serveBuild("manual");
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle()} devServer={devServer()} />);
    openMenu();
    const toggle = await screen.findByRole("menuitemcheckbox", { name: /Live updates/ });
    fireEvent.click(toggle);
    expect(screen.getByRole("menu", { name: "Profile" })).toBeDefined();
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });

  it("is walked by the arrow keys like every other entry", async () => {
    serveBuild("auto");
    render(<ProfileRow usage={handle()} park={parkHandle()} restarts={restartsHandle()} devServer={devServer()} />);
    openMenu();
    const toggle = await screen.findByRole("menuitemcheckbox", { name: /Live updates/ });
    const menu = screen.getByRole("menu", { name: "Profile" });
    // Usage has focus on open; Desktop park is disabled in this fixture and skipped.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Restart stale sessions" }));
    // The notification entries are disabled here (no push support in the test DOM) and skipped.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Agent Radio" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Listen to Agent Radio here" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Voice tuning" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "MSE audio test" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(toggle);
  });
});
