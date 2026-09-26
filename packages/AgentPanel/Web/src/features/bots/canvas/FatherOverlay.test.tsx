/**
 * What the Father home says, and which switches it throws.
 *
 * Tested at the component rather than through the shell for the reason `BotCanvasStatus.test`
 * states: the shell's harness stands up a whole panel for a surface whose whole job is counts
 * and toggles.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { FatherButton, FatherOverlay } from "@/features/bots/canvas/FatherOverlay";

const session = (source: string, sessionId: string, title: string, activity?: string) =>
  ({ source, sessionId, title, ...(activity ? { activity } : {}) }) as unknown as SessionSummary;

const bot = (botId: string, name: string, sessions: SessionSummary[]) =>
  ({ botId, name, sessions }) as unknown as BotView;

const BOTS = [
  bot("a", "Alpha", [session("claude", "s1", "First", "live"), session("opencode", "s2", "Second")]),
  bot("b", "Beta", []),
];

const PROPS = {
  bots: BOTS,
  hues: new Map<string, number>(),
  ranks: new Map<string, number>(),
  machines: [] as readonly { key: string; label: string }[],
  keyOfBot: () => undefined as string | undefined,
  hiddenMachines: new Set<string>(),
  detachedSessionKeys: new Set<string>(),
  openKeys: new Set(["claude:s1"]),
  onToggleSession: () => undefined,
  onAddBot: () => undefined,
  onClose: () => undefined,
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("FatherButton", () => {
  it("floats while the home is shut and goes away once it opens", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<FatherButton open={false} onToggle={onToggle} />);
    const button = screen.getByRole("button", { name: "Father" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-controls", "father-home");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<FatherButton open onToggle={onToggle} />);
    expect(screen.queryByRole("button", { name: "Father" })).toBeNull();
  });
});

describe("FatherOverlay", () => {
  it("counts the roster and marks the sessions the strip has open", () => {
    render(<FatherOverlay {...PROPS} />);
    expect(screen.getByRole("status")).toHaveTextContent("2 bots · 1 open");
    const list = screen.getByRole("list", { name: "Bots and their sessions" });
    expect(within(list).getByText("Alpha")).toBeDefined();
    expect(within(list).getByText("Beta")).toBeDefined();
    // The pill reads as its session; the open/close direction rides the tooltip, because a pill
    // named "Close First" would rename every switch each time it is pressed.
    const first = screen.getByRole("button", { name: "First" });
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(first).toHaveAttribute("title", "Close First on the canvas");
    const second = screen.getByRole("button", { name: "Second" });
    expect(second).toHaveAttribute("aria-pressed", "false");
    expect(second).toHaveAttribute("title", "Open Second on the canvas");
  });

  it("throws a session's own switch rather than any Bot's", () => {
    const onToggleSession = vi.fn();
    render(<FatherOverlay {...PROPS} onToggleSession={onToggleSession} />);
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(onToggleSession).toHaveBeenCalledWith("opencode:s2");
  });

  it("says when a Bot has nothing to switch, closes, and adds", () => {
    const onClose = vi.fn();
    const onAddBot = vi.fn();
    render(<FatherOverlay {...PROPS} onClose={onClose} onAddBot={onAddBot} />);
    expect(screen.getByText("no sessions")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Close the Father home" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Add a Bot" }));
    expect(onAddBot).toHaveBeenCalledTimes(1);
  });

  it("hides what a hidden machine holds back, the way the strip does", () => {
    render(
      <FatherOverlay
        {...PROPS}
        machines={[{ key: "m1", label: "peer" }]}
        keyOfBot={(botId) => (botId === "b" ? "m1" : undefined)}
        hiddenMachines={new Set(["m1"])}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("1 of 2 bots");
    expect(screen.queryByText("Beta")).toBeNull();
  });

  it("leaves a session taken off the canvas to the sidebar that holds it", () => {
    render(<FatherOverlay {...PROPS} detachedSessionKeys={new Set(["opencode:s2"])} />);
    expect(screen.queryByRole("button", { name: "Second" })).toBeNull();
    expect(screen.getByRole("button", { name: "First" })).toBeDefined();
  });
});
