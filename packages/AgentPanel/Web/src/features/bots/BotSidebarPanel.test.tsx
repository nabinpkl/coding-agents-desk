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
import { BotAvatar, BotSidebarPanel } from "@/features/bots/BotSidebarPanel";
import { setBotFaces } from "@/features/bots/avatar/BotFace";

const bot = (botId: string, name: string): BotView => ({
  botId,
  name,
  sessionRefs: [],
  sessions: [],
  missingSessionRefs: [],
  environment: { path: `/Users/dev/${name}` },
  environmentAvailability: "available",
  metadata: {},
} as unknown as BotView);

const HOME = bot("b-home", "Home bot");
const PEER = bot("b-peer", "Peer bot");
/** A Bot with sessions, which is what the rows below are about. */
const WORK = {
  ...bot("b-work", "Work bot"),
  sessionRefs: [
    { source: "claude", sessionId: "s-1" },
    { source: "claude", sessionId: "s-2" },
  ],
  sessions: [
    { source: "claude", sessionId: "s-1", title: "First session", activity: "cold" },
    { source: "claude", sessionId: "s-2", title: "Second session", activity: "cold" },
  ],
} as unknown as BotView;
const LABELS = new Map([["b-home", "dev"], ["b-peer", "oracle"]]);

function panel(canvas: {
  detachedBotIds: ReadonlySet<string>;
  machineHiddenBotIds: ReadonlySet<string>;
  detachedSessionKeys?: ReadonlySet<string>;
  onToggle?: (bot: BotView) => void;
  /** The sessions whose cards are unfolded, which is what the shell passes as the selection. */
  openKeys?: ReadonlySet<string>;
}) {
  const open = canvas.openKeys ?? new Set<string>();
  const openBots = [HOME, PEER, WORK]
    .filter((each) => each.sessions.some((s) => open.has(`${s.source}:${s.sessionId}`)))
    .map((each) => each.botId);
  return render(
    <BotSidebarPanel
      bots={[HOME, PEER, WORK]}
      machineLabels={LABELS}
      loading={false}
      error={null}
      selectedBotIds={new Set(openBots)}
      selectedSessionKeys={open}
      onSelectSession={() => undefined}
      onAddSession={() => undefined}
      onRenameSession={() => undefined}
      onDetachSession={() => undefined}
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
 * The roster paints NO surfaces. A row wore its card's full fill for a while, which said both
 * things at once and said them in the canvas's own material: two columns of saturated bands beside
 * the canvas read as a second canvas rather than as an index of it. So the colour moved onto the
 * 32px mark, where it still names the session, and the row is the panel's ground. Whether there is
 * a card is what the mark's colour now answers alone: a session without one gives the mark up and
 * dims under a badge that says why.
 */
describe("BotSidebarPanel session rows", () => {
  const rowOf = (title: string) => screen.getByText(title).closest("li")!;
  /** The session's mark, which is the only thing in the row that carries a colour. */
  const markOf = (title: string) => rowOf(title).querySelector(".bot-session-accent");

  it("keeps the row neutral and puts the session's colour on its mark", () => {
    panel({ detachedBotIds: new Set(), machineHiddenBotIds: new Set() });
    const row = rowOf("First session").className;
    expect(row).not.toContain("bot-session-fill");
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
    expect(rowOf("Second session").className).toContain("opacity-55");
    // Dim alone reads as disabled, so the badge is what carries the meaning. Counted inside the
    // session list: a Bot's own header wears the same badge, and the whole panel would count that.
    const rows = within(screen.getByRole("list", { name: "Work bot sessions" }));
    expect(rows.getAllByLabelText("Off the canvas")).toHaveLength(1);
    // Its neighbour still has a card, so it keeps both its colour and its full strength.
    expect(markOf("First session")).not.toBeNull();
    expect(rowOf("First session").className).not.toContain("opacity-55");
  });

  it("says the same of every session when the whole Bot is off the strip", () => {
    // The other way for a session to have no card. A row cannot act on the difference between the
    // two, so it states the one thing a reader can see: there is no card for this right now.
    panel({ detachedBotIds: new Set(["b-work"]), machineHiddenBotIds: new Set() });
    const rows = within(screen.getByRole("list", { name: "Work bot sessions" }));
    expect(rows.getAllByLabelText("Off the canvas")).toHaveLength(2);
    expect(markOf("First session")).toBeNull();
    expect(rowOf("Second session").className).toContain("opacity-55");
  });
});

/**
 * A Bot entry says the same things its sessions say, one level up: whose entry this is, and
 * whether there is a card to match.
 *
 * The rail is the whole of the first answer and it belongs to the ENTRY, not to the header row,
 * because a bar running past the sessions too is what makes a Bot and its sessions one block. The
 * header's fill went with the session fills, for the reason written above them.
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

  it("wears its Bot's rail, and no fill under it, while it has a card", () => {
    panel({ detachedBotIds: new Set(), machineHiddenBotIds: new Set() });
    expect(entryOf("Work bot").className).toContain("bot-rail");
    expect(headerOf("Work bot").className).not.toContain("bot-surface");
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
 * The faces switch: initials until chosen, faces everywhere a rank reaches after.
 *
 * The avatar toggle in the header above this list is the switch's one control; what is pinned
 * here is what it changes. An unranked Bot keeps its initials whatever the switch says, because
 * the creator's preview is of a Bot that does not exist and ranking it would promise a face the
 * roster may not give it.
 */
describe("BotSidebarPanel faces switch", () => {
  beforeEach(() => {
    localStorage.clear();
    setBotFaces(false);
  });

  it("a ranked Bot wears its initials until faces are chosen", () => {
    const { container, rerender } = render(<BotAvatar bot={{ name: "Alpha Bot" }} hue={24} rank={0} />);
    expect(container.textContent).toContain("AB");
    expect(container.querySelector(".bot-face")).toBeNull();

    setBotFaces(true);
    rerender(<BotAvatar bot={{ name: "Alpha Bot" }} hue={24} rank={0} />);
    expect(container.querySelector(".bot-face")).not.toBeNull();
    expect(container.textContent).not.toContain("AB");
  });

  it("a Bot with no rank keeps its initials when faces are on", () => {
    setBotFaces(true);
    const { container } = render(<BotAvatar bot={{ name: "New Bot" }} />);
    expect(container.textContent).toContain("NB");
    expect(container.querySelector(".bot-face")).toBeNull();
  });

  it("a press reaches avatars mounted after it", () => {
    const { container, unmount } = render(<BotAvatar bot={{ name: "Alpha Bot" }} hue={24} rank={0} />);
    expect(container.querySelector(".bot-face")).toBeNull();
    setBotFaces(true);
    unmount();
    const { container: next } = render(<BotAvatar bot={{ name: "Alpha Bot" }} hue={24} rank={0} />);
    expect(next.querySelector(".bot-face")).not.toBeNull();
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
