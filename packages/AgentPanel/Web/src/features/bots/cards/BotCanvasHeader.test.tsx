/**
 * A Bot card header that is too narrow for its own controls, and what it does with them.
 *
 * A card is exactly as wide as the sessions standing in it, so two cards on one strip can want
 * opposite headers. The wide row keeps the code, git and terminal buttons; the narrow one spends
 * that width on the Bot's name and offers the same three acts from its more menu, opening the same
 * dialogs. The dialogs are stubbed here -- they have their own coverage -- and the git mark is
 * checked for staying put, because a fact is not a control and the row can still afford it.
 *
 * Width is driven by a recording `ResizeObserver` and a `getBoundingClientRect` this file owns,
 * since jsdom lays nothing out: the header reads its own box, and an unmeasured header is wide.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotGitStatus, BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { BotCanvasHeader } from "@/features/bots/cards/BotCanvasHeader";

vi.mock("@/features/bots/code/BotCodeDialog", () => ({
  BotCodeDialog: (props: { bot: BotView; initialSection: string }) => (
    <div role="dialog" aria-label={props.bot.name} data-section={props.initialSection} />
  ),
}));

vi.mock("@/features/terminal/MachineTerminalDialog", () => ({
  TerminalShellDialog: (props: { title: string }) => <div role="dialog" aria-label={props.title} />,
}));

const bot: BotView = {
  botId: "bot-1",
  name: "Bridget (Review Bot)",
  environment: { kind: "directory", path: "/projects/ecc" },
  sessionRefs: [],
  metadata: { role: "Review Bot", labels: [], custom: {} },
  grants: [],
  createdAt: 1,
  createdBy: { kind: "user" },
  environmentAvailability: "available",
  sessions: [],
  missingSessionRefs: [],
};

/** Two uncommitted files, so the git act has a count to carry. */
const CHANGED: BotGitStatus = {
  botId: "bot-1",
  repository: true,
  branch: "main",
  entries: [
    { relativePath: "src/a.ts", indexStatus: null, workTreeStatus: "M" },
    { relativePath: "notes.md", indexStatus: "?", workTreeStatus: "?" },
  ],
};

const NOT_A_REPO: BotGitStatus = { botId: "bot-1", repository: false, branch: null, entries: [] };

function feedFor(git: BotGitStatus | Error) {
  return {
    subscribeBotGit: vi.fn((_botId: string, onStatus: (status: BotGitStatus) => void, onError: (reason: string) => void) => {
      queueMicrotask(() => (git instanceof Error ? onError(git.message) : onStatus(git)));
      return () => {};
    }),
    killTmuxSession: vi.fn(),
  } as unknown as SidecarDataSource;
}

const PROPS = {
  hue: 210,
  rank: 0,
  onMoveStart: () => {},
  onMoveBy: () => {},
  onMoveEnd: () => {},
  onMoveBySteps: () => {},
  canMoveLeft: true,
  canMoveRight: true,
  onAddSession: () => {},
  onDetachBot: () => {},
  onRenameBot: () => {},
  onDeleteBot: () => {},
  fileRequest: null,
  onCloseFile: () => {},
};

/** The header's own width, and every observer the hook left running. */
let headerWidth = 0;
const observers: (() => void)[] = [];

function renderHeader(over: Partial<typeof PROPS> & { bot?: BotView; feed?: SidecarDataSource } = {}) {
  return render(
    <BotCanvasHeader
      bot={over.bot ?? bot}
      feed={over.feed ?? feedFor(CHANGED)}
      {...PROPS}
      {...over}
    />,
  );
}

/**
 * Rendered, and then let the git subscription land.
 *
 * The subscription answers on a microtask, so a header that has only just mounted is still in the
 * `unanswered` state and draws no git control at all. Every assertion here is about a header that
 * knows what its directory has, so the flush is part of arriving, not a detail of the test.
 */
async function renderSettled(
  over: Partial<typeof PROPS> & { bot?: BotView; feed?: SidecarDataSource } = {},
): Promise<void> {
  renderHeader(over);
  await act(async () => {
    await Promise.resolve();
  });
}

function openMenu(): void {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${bot.name}` }));
}

beforeEach(() => {
  observers.length = 0;
  headerWidth = 0;
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      return { width: headerWidth, height: 0, top: 0, left: 0, right: headerWidth, bottom: 0, x: 0, y: 0, toJSON: () => ({}) };
    },
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    // Records the callback and never fires it on its own, so a test decides when a resize
    // happened: which is the whole difference between a card that measured itself and a card
    // sitting in a hidden tab with no width to measure.
    value: class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

/** Resizes every mounted header, which is what the real observer would do. */
function resize(to: number): void {
  headerWidth = to;
  act(() => {
    for (const fire of observers) fire();
  });
}

describe("a header with room for its controls", () => {
  it("keeps them in the row, and the menu free of them", async () => {
    resize(900);
    await renderSettled();
    expect(screen.getByRole("button", { name: "Browse the code in Bridget (Review Bot)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Show git changes in Bridget/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open a terminal in Bridget (Review Bot)" })).toBeTruthy();
    openMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Move left",
      "Move right",
      "Remove from canvas",
      "Rename Bot",
      "Delete Bot",
    ]);
  });
});

describe("a header without room for them", () => {
  it("moves the three into the menu, above the arrangement acts", async () => {
    resize(360);
    await renderSettled();
    expect(screen.queryByRole("button", { name: "Browse the code in Bridget (Review Bot)" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Show git changes in Bridget/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open a terminal in Bridget (Review Bot)" })).toBeNull();
    // What stays is the name and the add button: the name is what the width was spent on.
    expect(screen.getByText("Bridget (Review Bot)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add sessions to Bridget (Review Bot)" })).toBeTruthy();
    openMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Browse code",
      "Show git changes (2 changed files)",
      "Open terminal",
      "Move left",
      "Move right",
      "Remove from canvas",
      "Rename Bot",
      "Delete Bot",
    ]);
  });

  it("opens the same dialogs the buttons would have", async () => {
    resize(360);
    await renderSettled();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Browse code" }));
    expect(screen.getByRole("dialog", { name: bot.name }).dataset.section).toBe("explorer");

    cleanup();
    await renderSettled();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Show git changes (2 changed files)" }));
    expect(screen.getByRole("dialog", { name: bot.name }).dataset.section).toBe("sourceControl");

    cleanup();
    await renderSettled();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal" }));
    expect(screen.getByRole("dialog", { name: `Terminal in ${bot.name}` })).toBeTruthy();
  });

  it("waits for the width, so a card that has not been measured keeps its controls", async () => {
    // Nothing has been measured: a hidden tab, or a card mounted before its sessions arrive.
    await renderSettled();
    expect(screen.getByRole("button", { name: "Browse the code in Bridget (Review Bot)" })).toBeTruthy();
    resize(360);
    expect(screen.queryByRole("button", { name: "Browse the code in Bridget (Review Bot)" })).toBeNull();
  });

  it("gives the width back when the card grows", async () => {
    resize(360);
    await renderSettled();
    expect(screen.queryByRole("button", { name: "Open a terminal in Bridget (Review Bot)" })).toBeNull();
    resize(900);
    expect(screen.getByRole("button", { name: "Open a terminal in Bridget (Review Bot)" })).toBeTruthy();
  });

  it("offers no git act outside a repository, as the button never was", async () => {
    resize(360);
    await renderSettled({ feed: feedFor(NOT_A_REPO) });
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /git changes/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Browse code" })).toBeTruthy();
  });

  it("offers nothing at all for a Bot whose directory is missing", async () => {
    resize(360);
    await renderSettled({ bot: { ...bot, environmentAvailability: "missing" } });
    openMenu();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Move left",
      "Move right",
      "Remove from canvas",
      "Rename Bot",
      "Delete Bot",
    ]);
  });

  it("keeps the git failure in the row, because a mark is not a control", async () => {
    resize(360);
    await renderSettled({ feed: feedFor(new Error("the sidecar answered 500")) });
    expect(screen.getByRole("img", { name: "Git changes unavailable: the sidecar answered 500" })).toBeTruthy();
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /git changes/ })).toBeNull();
  });
});
