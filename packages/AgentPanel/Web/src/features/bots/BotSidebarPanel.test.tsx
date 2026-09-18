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

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import { BotSidebarPanel } from "@/features/bots/BotSidebarPanel";

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
}) {
  return render(
    <BotSidebarPanel
      bots={[HOME, PEER, WORK]}
      machineLabels={LABELS}
      loading={false}
      error={null}
      selectedBotIds={new Set()}
      selectedSessionKeys={new Set()}
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
 * Both used to be spent on the same pixels. The row carried its Bot's colour as a 2px rail because
 * a background tint would have fought the dimming that meant "off the canvas", so the colour that
 * names a session was the one that gave way. The row takes the full fill now, and the two stopped
 * competing by being made one answer: a session is painted exactly when it has a card, and a row
 * without one goes neutral and dim under a mark that says so.
 */
describe("BotSidebarPanel session rows", () => {
  const rowOf = (title: string) => screen.getByText(title).closest("li")!;

  it("paints a session row in its own colour rather than leaving it grey", () => {
    panel({ detachedBotIds: new Set(), machineHiddenBotIds: new Set() });
    expect(rowOf("First session").className).toContain("bot-session-fill");
  });

  it("takes the colour off a session with no card, dims it, and says why", () => {
    panel({
      detachedBotIds: new Set(),
      machineHiddenBotIds: new Set(),
      detachedSessionKeys: new Set(["claude:s-2"]),
    });
    const gone = rowOf("Second session").className;
    expect(gone).not.toContain("bot-session-fill");
    expect(gone).toContain("opacity-55");
    // Dim alone reads as disabled, so the mark is what carries the meaning.
    expect(screen.getAllByLabelText("Off the canvas")).toHaveLength(1);
    // Its neighbour still has a card, so it keeps both its colour and its full strength.
    const kept = rowOf("First session").className;
    expect(kept).toContain("bot-session-fill");
    expect(kept).not.toContain("opacity-55");
  });

  it("says the same of every session when the whole Bot is off the strip", () => {
    // The other way for a session to have no card. A row cannot act on the difference between the
    // two, so it states the one thing a reader can see: there is no card for this right now.
    panel({ detachedBotIds: new Set(["b-work"]), machineHiddenBotIds: new Set() });
    expect(screen.getAllByLabelText("Off the canvas")).toHaveLength(2);
    expect(rowOf("First session").className).not.toContain("bot-session-fill");
    expect(rowOf("Second session").className).toContain("opacity-55");
  });
});
