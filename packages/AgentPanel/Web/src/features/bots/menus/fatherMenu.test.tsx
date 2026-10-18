/**
 * Naming a Bot's Father from its session menu, and renaming or deleting the Bot from its card.
 *
 * The menu shows the other act: a session that is not the Father offers the naming, the one
 * that is offers the clearing, and a row with no session to render offers neither. The card
 * menu carries the Bot-level acts below the canvas arrangement, with delete last.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SessionRowMenu } from "@/features/bots/menus/SessionRowMenu";
import { BotCardMenu } from "@/features/bots/menus/BotCardMenu";
import type { BotView } from "@agentdesk/agent-feed-wire";

const bot = {
  botId: "bot-1",
  name: "Captain",
  environment: { kind: "directory", path: "/projects/alpha" },
  sessionRefs: [],
} as unknown as BotView;

function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: /Actions for/ }));
}

describe("the Father on the session menu", () => {
  it("offers the naming on a session that is not the Father", () => {
    const onSetFather = vi.fn();
    render(<SessionRowMenu label="sid-1" onDetach={() => {}} onSetFather={onSetFather} onClearFather={() => {}} />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Set as Father" }));
    expect(onSetFather).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Clear as Father" })).toBeNull();
  });

  it("offers the clearing on the session that is", () => {
    const onClearFather = vi.fn();
    render(
      <SessionRowMenu
        label="sid-1"
        onDetach={() => {}}
        isFather
        onSetFather={() => {}}
        onClearFather={onClearFather}
      />,
    );
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear as Father" }));
    expect(onClearFather).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "Set as Father" })).toBeNull();
  });

  it("offers neither on a missing reference, which the home could not render", () => {
    render(<SessionRowMenu label="sid-gone" onDetach={() => {}} />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Set as Father" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Clear as Father" })).toBeNull();
  });
});

describe("the Bot on its card menu", () => {
  it("renames above and deletes last", () => {
    const onRenameBot = vi.fn();
    const onDeleteBot = vi.fn();
    render(<BotCardMenu bot={bot} onDetach={() => {}} onRenameBot={onRenameBot} onDeleteBot={onDeleteBot} />);
    openMenu();
    const names = screen.getAllByRole("menuitem").map((item) => item.textContent);
    expect(names).toEqual(["Remove from canvas", "Rename Bot", "Delete Bot"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Bot" }));
    expect(onRenameBot).toHaveBeenCalledTimes(1);
  });

  it("shows neither where the card stands alone", () => {
    render(<BotCardMenu bot={bot} onDetach={() => {}} />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Rename Bot" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete Bot" })).toBeNull();
  });
});
