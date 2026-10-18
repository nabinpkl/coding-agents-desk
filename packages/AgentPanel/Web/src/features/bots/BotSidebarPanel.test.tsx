/**
 * How the canvas roster marks a Bot with no card, and which of its two reasons it can act on.
 *
 * There are two ways to be off the canvas and they have different controls. A Bot the reader took
 * off comes back from its own row. A Bot whose MACHINE is hidden comes back from the chip above the
 * roster, and its row must not offer the first answer to the second question -- pressing the avatar
 * there would move this Bot's own membership and leave the strip exactly as it was.
 *
 * Tested at the component because the shell's harness mounts a single-machine panel, where no
 * machine can be hidden at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { BotSidebarPanel } from "@/features/bots/BotSidebarPanel";
import { setBotFaces } from "@/features/bots/avatar/botFacesSwitch";

const bot = (botId: string, name: string, createdAt = 0): BotView =>
  ({
    botId,
    name,
    createdAt,
    sessionRefs: [],
    sessions: [],
    missingSessionRefs: [],
    environment: { path: `/Users/dev/${name}` },
    environmentAvailability: "available",
    metadata: {},
  }) as unknown as BotView;

const HOME = bot("b-home", "Home bot", 100);
const PEER = bot("b-peer", "Peer bot", 200);
/** A Bot with sessions, which is what the rows below are about. */
const WORK = {
  ...bot("b-work", "Work bot", 300),
  sessionRefs: [
    { source: "claude", sessionId: "s-1" },
    { source: "claude", sessionId: "s-2" },
  ],
  sessions: [
    { source: "claude", sessionId: "s-1", title: "First session", activity: "cold", lastEventAt: 400 },
    { source: "claude", sessionId: "s-2", title: "Second session", activity: "cold", lastEventAt: 500 },
  ],
} as unknown as BotView;
const LABELS = new Map([
  ["b-home", "dev"],
  ["b-peer", "oracle"],
]);
/** A Bot with more sessions than the roster will draw once they are off the canvas. */
const MANY = {
  ...bot("b-many", "Many bot", 400),
  sessionRefs: Array.from({ length: 6 }, (_, index) => ({ source: "claude", sessionId: `m-${index}` })),
  sessions: Array.from({ length: 6 }, (_, index) => ({
    source: "claude",
    sessionId: `m-${index}`,
    title: `Many session ${index}`,
    activity: "cold",
    lastEventAt: index,
  })),
} as unknown as BotView;

function panel(canvas: {
  detachedBotIds: ReadonlySet<string>;
  machineHiddenBotIds: ReadonlySet<string>;
  detachedSessionKeys?: ReadonlySet<string>;
  onToggle?: (bot: BotView) => void;
  /** The sessions whose cards are unfolded, which is what the shell passes as the selection. */
  openKeys?: ReadonlySet<string>;
  /** The roster to render, for the cases three Bots with two sessions cannot put on screen. */
  bots?: BotView[];
}) {
  const bots = canvas.bots ?? [HOME, PEER, WORK];
  const open = canvas.openKeys ?? new Set<string>();
  const openBots = bots
    .filter((each) => each.sessions.some((s) => open.has(`${s.source}:${s.sessionId}`)))
    .map((each) => each.botId);
  return render(
    <BotSidebarPanel
      bots={bots}
      machineLabels={LABELS}
      loading={false}
      error={null}
      selectedBotIds={new Set(openBots)}
      selectedSessionKeys={open}
      onSelectSession={() => undefined}
      onAddSession={() => undefined}
      onRenameSession={() => undefined}
      onDetachSession={() => undefined}
      onSetFatherSession={() => undefined}
      onAddBot={() => undefined}
      canvas={{
        detachedBotIds: canvas.detachedBotIds,
        machineHiddenBotIds: canvas.machineHiddenBotIds,
        detachedSessionKeys: canvas.detachedSessionKeys ?? new Set(),
        onToggle: canvas.onToggle ?? (() => undefined),
      }}
    />,
  );
}

/** The row's avatar control, which is also the thing that says whether the Bot has a card. */
const control = (name: RegExp) => screen.getByRole("button", { name });

afterEach(cleanup);

describe("BotSidebarPanel canvas rows", () => {
  it("marks a Bot on a hidden machine as having no card, and says which machine", () => {
    const { container } = panel({
      detachedBotIds: new Set(),
      machineHiddenBotIds: new Set(["b-peer"]),
    });
    // The Bot is attached -- nothing detached it -- and still has no card. Before this the row
    // wore a tick for being attached while the strip showed nothing, which is the one state a
    // reader cannot reason about.
    const peer = control(/oracle, which is hidden/);
    expect(peer).toHaveAttribute("aria-pressed", "false");
    expect(peer).toBeDisabled();
    expect(container.textContent).toContain("oracle hidden");

    // Its neighbour on a shown machine is untouched.
    const home = control(/Take Home bot off the canvas/);
    expect(home).toHaveAttribute("aria-pressed", "true");
    expect(home).toBeEnabled();
  });

  it("refuses the press, because it would move a state that changes nothing on screen", () => {
    const onToggle = vi.fn();
    panel({
      detachedBotIds: new Set(),
      machineHiddenBotIds: new Set(["b-peer"]),
      onToggle,
    });
    fireEvent.click(control(/oracle, which is hidden/));
    expect(onToggle).not.toHaveBeenCalled();
    // The control that DOES work is still live on the row above it.
    fireEvent.click(control(/Take Home bot off the canvas/));
    expect(onToggle).toHaveBeenCalledWith(HOME);
  });

  it("keeps the hidden-machine reading for a Bot that is also detached", () => {
    // Off the canvas twice. The row must not offer to put it back with one press, because putting
    // it back needs both, and the one this row owns is not the one holding the card.
    panel({
      detachedBotIds: new Set(["b-peer"]),
      machineHiddenBotIds: new Set(["b-peer"]),
    });
    expect(control(/oracle, which is hidden/)).toBeDisabled();
  });

  it("says nothing about machines when none is hidden", () => {
    const { container } = panel({
      detachedBotIds: new Set(["b-peer"]),
      machineHiddenBotIds: new Set(),
    });
    expect(container.textContent).not.toContain("hidden");
    const peer = control(/Put Peer bot on the canvas/);
    expect(peer).toHaveAttribute("aria-pressed", "false");
    expect(peer).toBeEnabled();
  });
});

/**
 * What a session row says about itself: which session it is, and whether it has a card.
 *
 * Nothing in this roster paints a surface. A row wore its card's full fill for a while, which said
 * both things at once and said them in the canvas's own material: a column of saturated bands
 * beside the canvas read as a second canvas rather than as an index of it. So the row is the
 * panel's ground, and the two questions go to two channels. The RAIL, one indent inside its Bot's,
 * is the Bot's own hue and says whose -- never the session's, because neighbours sit sixty degrees
 * apart around the whole circle and a grouping cue that varies inside the group is not one. The
 * FACE takes that turned hue and says which. A session with no card gives up both and dims under a
 * badge that says why.
 */
describe("BotSidebarPanel session rows", () => {
  const rowOf = (title: string) => screen.getByText(title).closest("li")!;
  /** The session's mark, which is the only thing in the row that carries a colour. */
  const markOf = (title: string) => rowOf(title).querySelector(".bot-session-accent");

  it("keeps the row unfilled and puts the session's colour on its rail and its mark", () => {
    panel({ detachedBotIds: new Set(), machineHiddenBotIds: new Set() });
    const row = rowOf("First session").className;
    expect(row).not.toContain("bot-session-fill");
    // The rail, not the laddered edge, which is invisible at the first step without a fill to ring.
    expect(row).toContain("bot-rail");
    expect(row).not.toContain("bot-session-edge");
    expect(markOf("First session")).not.toBeNull();
  });

  it("takes the colour off a session with no card, dims it, and says why", () => {
    panel({
      detachedBotIds: new Set(),
      machineHiddenBotIds: new Set(),
      detachedSessionKeys: new Set(["claude:s-2"]),
    });
    expect(markOf("Second session")).toBeNull();
    expect(rowOf("Second session").className).not.toContain("bot-rail");
    expect(rowOf("Second session").className).toContain("opacity-55");
    // Dim alone reads as disabled, so the badge is what carries the meaning. Counted inside the
    // session list: a Bot's own header wears the same badge, and the whole panel would count that.
    const rows = within(screen.getByRole("list", { name: "Work bot sessions" }));
    expect(rows.getAllByLabelText("Off the canvas")).toHaveLength(1);
    // Its neighbour still has a card, so it keeps both its colour and its full strength.
    expect(markOf("First session")).not.toBeNull();
    expect(rowOf("First session").className).toContain("bot-rail");
    expect(rowOf("First session").className).not.toContain("opacity-55");
  });

  it("says the same of every session when the whole Bot is off the strip", () => {
    // The other way for a session to have no card. A row cannot act on the difference between the
    // two, so it states the one thing a reader can see: there is no card for this right now.
    panel({ detachedBotIds: new Set(["b-work"]), machineHiddenBotIds: new Set() });
    const rows = within(screen.getByRole("list", { name: "Work bot sessions" }));
    expect(rows.getAllByLabelText("Off the canvas")).toHaveLength(2);
    expect(markOf("First session")).toBeNull();
    expect(rowOf("First session").className).not.toContain("bot-rail");
    expect(rowOf("Second session").className).toContain("opacity-55");
  });
});

/**
 * A Bot entry says the same things its sessions say, one level up: whose entry this is, and
 * whether there is a card to match.
 *
 * The rail answers the first and it is on the ENTRY rather than the header, because a bar running
 * past the sessions is what makes a Bot and its sessions one block. Nothing here is filled: the
 * header wore its card's tint for one commit and gave it back, because the sidebar does not want a
 * background colour at any strength. The rail goes when the card does.
 */
describe("BotSidebarPanel bot rows", () => {
  /**
   * The header strip of one Bot's entry, and the entry around it.
   *
   * Found through the Add-sessions button rather than the Bot's name, because these fixtures give
   * each Bot a directory named after it, so the name renders twice in one row -- once as the title
   * and once in the path line under it -- and matching on it finds both.
   */
  const addOf = (name: string) => screen.getByRole("button", { name: `Add sessions to ${name}` });
  const headerOf = (name: string) => addOf(name).closest("div")!;
  const entryOf = (name: string) => addOf(name).closest("li")!;
  const rowOf = (title: string) => screen.getByText(title).closest("li")!;

  it("wears its Bot's rail on the entry, and fills nothing under it", () => {
    panel({ detachedBotIds: new Set(), machineHiddenBotIds: new Set() });
    expect(entryOf("Work bot").className).toContain("bot-rail");
    expect(headerOf("Work bot").className).not.toContain("bot-surface");
    expect(rowOf("First session").className).not.toContain("bot-surface");
  });

  it("gives the rail up, dims and says so when it has no card", () => {
    panel({ detachedBotIds: new Set(["b-work"]), machineHiddenBotIds: new Set() });
    expect(entryOf("Work bot").className).not.toContain("bot-rail");
    const header = headerOf("Work bot");
    expect(header.className).toContain("opacity-55");
    expect(within(header).getByLabelText("Off the canvas")).toBeInTheDocument();
  });

  it("says it the same way when a hidden machine is what is holding the card back", () => {
    // Two routes to having no card, one appearance. The control keeps the distinction, because
    // only it can act on it; the rail and the badge are about what is on the strip.
    panel({ detachedBotIds: new Set(), machineHiddenBotIds: new Set(["b-peer"]) });
    expect(entryOf("Peer bot").className).not.toContain("bot-rail");
    expect(within(headerOf("Peer bot")).getByLabelText("Off the canvas")).toBeInTheDocument();
  });
});

/**
 * Where a Bot with no card sits.
 *
 * The roster is read while looking at the canvas, so a Bot that was taken off it months ago
 * sitting between two the reader is working in costs them the scan every time. Dimming said
 * which was which and did nothing about where they were.
 */
describe("BotSidebarPanel roster order", () => {
  /** The Bot names in the order their rows stand in. */
  const order = () => {
    const text = screen.getByRole("list", { name: "Bots" }).textContent ?? "";
    return ["Home bot", "Peer bot", "Work bot"].sort((a, b) => text.indexOf(a) - text.indexOf(b));
  };

  it("leaves the roster alone while every Bot has a card", () => {
    panel({ detachedBotIds: new Set(), machineHiddenBotIds: new Set() });
    expect(order()).toEqual(["Home bot", "Peer bot", "Work bot"]);
  });

  it("sinks a Bot the reader took off the canvas", () => {
    panel({ detachedBotIds: new Set(["b-home"]), machineHiddenBotIds: new Set() });
    expect(order()).toEqual(["Peer bot", "Work bot", "Home bot"]);
  });

  it("sinks a Bot whose machine is hidden the same way", () => {
    // Two ways to have no card, one place the row goes: from here they read identically, and the
    // controls that undo them are what differ.
    panel({ detachedBotIds: new Set(), machineHiddenBotIds: new Set(["b-peer"]) });
    expect(order()).toEqual(["Home bot", "Work bot", "Peer bot"]);
  });

  it("puts the liveliest of the sunk Bots first", () => {
    // Peer bot was created after Home bot and neither has a session, so it is the newer of two
    // quiet Bots -- which is the only ordering either of them can offer.
    panel({ detachedBotIds: new Set(["b-home", "b-peer"]), machineHiddenBotIds: new Set() });
    expect(order()).toEqual(["Work bot", "Peer bot", "Home bot"]);
  });
});

/**
 * A Bot's own rows: the ones with cards above the ones without, and a fold once the second group
 * stops being a tail and starts being a second list.
 *
 * Driven through the panel because that is the row's only mount, and because what is being pinned
 * is the order a reader sees rather than the split that produces it, which `botRosterOrder.test.ts`
 * asks directly.
 */
describe("BotSidebarPanel session rows", () => {
  /** The session titles in the order their rows stand in, inside one Bot. */
  const titles = (botName: string, names: string[]) => {
    const text = screen.getByRole("list", { name: `${botName} sessions` }).textContent ?? "";
    return [...names].sort((a, b) => text.indexOf(a) - text.indexOf(b));
  };

  it("puts a session with no card below the ones that have one", () => {
    panel({
      detachedBotIds: new Set(),
      machineHiddenBotIds: new Set(),
      detachedSessionKeys: new Set(["claude:s-1"]),
    });
    // First session is off the canvas and was listed first; it now sits under its sibling.
    expect(titles("Work bot", ["First session", "Second session"])).toEqual(["Second session", "First session"]);
  });

  it("lists a few off-canvas sessions rather than folding them", () => {
    panel({ detachedBotIds: new Set(), machineHiddenBotIds: new Set() });
    // Not the avatar toggles, which also say "off the canvas": the fold row alone.
    expect(screen.queryByRole("button", { name: /^(?:Show|Hide) \d+ off the canvas$/ })).toBeNull();
    expect(screen.getByText("First session")).toBeDefined();
  });

  it("folds the off-canvas sessions once there are more than three", () => {
    panel({
      detachedBotIds: new Set(),
      machineHiddenBotIds: new Set(),
      detachedSessionKeys: new Set(["claude:m-0", "claude:m-1", "claude:m-2", "claude:m-3"]),
      bots: [MANY],
    });
    const fold = screen.getByRole("button", { name: "Show 4 off the canvas" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Many session 0")).toBeNull();
    // The two with cards are untouched by the fold.
    expect(screen.getByText("Many session 4")).toBeDefined();

    fireEvent.click(fold);
    expect(screen.getByRole("button", { name: "Hide 4 off the canvas" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Many session 0")).toBeDefined();
  });

  it("folds every session of a Bot that is off the canvas itself", () => {
    // The case that made the fold necessary: nothing on the strip, so the row was spending a
    // screen of dimmed entries on the one Bot the reader had just said they were done with.
    panel({ detachedBotIds: new Set(["b-many"]), machineHiddenBotIds: new Set(), bots: [MANY] });
    expect(screen.getByRole("button", { name: "Show 6 off the canvas" })).toBeDefined();
    expect(screen.queryByText("Many session 0")).toBeNull();
  });
});

describe("BotSidebarPanel folded sessions", () => {
  beforeEach(() => {
    localStorage.clear();
    setBotFaces(true);
  });

  /** Both of Work bot's session rows, which is where a fold has to be readable. */
  const rows = () => screen.getByRole("list", { name: "Work bot sessions" });

  it("closes the eyes of a session whose card is folded", () => {
    panel({
      detachedBotIds: new Set(),
      machineHiddenBotIds: new Set(),
      openKeys: new Set(["claude:s-1"]),
    });
    // One open card and one folded, so the assertion is about the difference between two rows
    // rather than about a count that an unrelated change could satisfy.
    expect(rows().querySelectorAll(".bot-face-eyes--open")).toHaveLength(1);
    expect(rows().querySelectorAll(".bot-face-eyes--shut")).toHaveLength(1);
  });

  it("closes every eye when nothing is open", () => {
    panel({ detachedBotIds: new Set(), machineHiddenBotIds: new Set() });
    expect(rows().querySelectorAll(".bot-face-eyes--open")).toHaveLength(0);
    expect(rows().querySelectorAll(".bot-face-eyes--shut")).toHaveLength(2);
  });
});

describe("BotSidebarPanel terminal buttons", () => {
  const feed = {} as unknown as SidecarDataSource;
  const withFeed = () =>
    render(
      <BotSidebarPanel
        bots={[HOME, PEER]}
        machineLabels={LABELS}
        feedForBot={() => feed}
        loading={false}
        error={null}
        selectedBotIds={new Set()}
        selectedSessionKeys={new Set()}
        onSelectSession={() => undefined}
        onAddSession={() => undefined}
        onRenameSession={() => undefined}
        onDetachSession={() => undefined}
        onSetFatherSession={() => undefined}
        onAddBot={() => undefined}
      />,
    );

  it("offers a directory shell in each Bot header when the shell names a feed", () => {
    withFeed();
    expect(screen.getByRole("button", { name: "Open a terminal in Home bot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open a terminal in Peer bot" })).toBeTruthy();
  });

  it("offers no directory shell when the roster was rendered without a shell behind it", () => {
    panel({ detachedBotIds: new Set(), machineHiddenBotIds: new Set() });
    expect(screen.queryByRole("button", { name: /Open a terminal in/ })).toBeNull();
  });
});
