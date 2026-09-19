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
const LABELS = new Map([["b-home", "dev"], ["b-peer", "oracle"]]);

function panel(canvas: {
  detachedBotIds: ReadonlySet<string>;
  machineHiddenBotIds: ReadonlySet<string>;
  onToggle?: (bot: BotView) => void;
}) {
  return render(
    <BotSidebarPanel
      bots={[HOME, PEER]}
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
        detachedSessionKeys: new Set(),
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
