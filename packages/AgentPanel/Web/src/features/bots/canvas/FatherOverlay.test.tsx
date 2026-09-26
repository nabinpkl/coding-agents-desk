/**
 * Which session the Father home shows, and what it says while it cannot show one.
 *
 * The resolved session renders through the real `SessionView`, which owns live streams and is
 * therefore asserted on the live panel rather than here: jsdom covers the declaration logic and
 * the two states that say something instead. The stub below stands in for the session surface so
 * the wiring (which session, which error) is still checked.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { FatherButton, FatherOverlay, resolveFather } from "@/features/bots/canvas/FatherOverlay";

vi.mock("@/features/session-view/SessionView", () => ({
  SessionView: (props: { session: SessionSummary; externalError?: string | null }) => (
    <div data-testid="father-session" data-error={props.externalError ?? ""}>
      {props.session.sessionId}
    </div>
  ),
}));

const session = (source: string, sessionId: string, title: string) =>
  ({ source, sessionId, title }) as unknown as SessionSummary;

const bot = (botId: string, extra: Partial<BotView>) =>
  ({
    botId,
    name: botId,
    environment: { kind: "directory", path: "/repo" },
    sessions: [],
    ...extra,
  }) as unknown as BotView;

const FATHER = bot("a", {
  sessions: [session("opencode", "s1", "First"), session("claude", "s2", "Second")],
  fatherSession: { source: "opencode", sessionId: "s1" },
});

const PROPS = {
  bots: [FATHER],
  sessionContextFor: () => ({}) as never,
  attachSessionToBot: () => () => undefined,
  onDetachSession: () => undefined,
  botError: null,
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

describe("resolveFather", () => {
  it("names nothing until a Bot declares a Father", () => {
    expect(resolveFather([])).toBeNull();
    expect(resolveFather([bot("a", {})])).toBeNull();
  });

  it("resolves the declaration against the Bot's own sessions", () => {
    const resolved = resolveFather([FATHER]);
    expect(resolved && "session" in resolved && resolved.session.sessionId).toBe("s1");
  });

  it("says missing rather than silently unnaming a forgotten session", () => {
    const gone = bot("a", {
      sessions: [session("claude", "s2", "Second")],
      fatherSession: { source: "opencode", sessionId: "s1" },
    });
    const resolved = resolveFather([gone]);
    expect(resolved && "missing" in resolved && resolved.missing).toEqual({
      source: "opencode",
      sessionId: "s1",
    });
  });

  it("takes the first Bot that names one, in canvas order", () => {
    const second = bot("b", {
      sessions: [session("claude", "s9", "Ninth")],
      fatherSession: { source: "claude", sessionId: "s9" },
    });
    const resolved = resolveFather([FATHER, second]);
    expect(resolved && "session" in resolved && resolved.bot.botId).toBe("a");
  });
});

describe("FatherOverlay", () => {
  it("renders the declared session through the session surface", () => {
    render(<FatherOverlay {...PROPS} />);
    const surface = screen.getByTestId("father-session");
    expect(surface).toHaveTextContent("s1");
    expect(surface).toHaveAttribute("data-error", "");
    // Both grips of the same hook: the bottom grows it taller, the edge wider.
    expect(screen.getByRole("separator", { name: "Resize Father home card" })).toBeDefined();
    expect(screen.getByRole("separator", { name: "Widen Father home card" })).toBeDefined();
  });

  it("carries a Bot failure about the Father session, and no other", () => {
    const { rerender } = render(
      <FatherOverlay {...PROPS} botError={{ session: "opencode:s1", message: "detach failed" }} />,
    );
    expect(screen.getByTestId("father-session")).toHaveAttribute("data-error", "detach failed");

    rerender(
      <FatherOverlay {...PROPS} botError={{ session: "claude:s2", message: "detach failed" }} />,
    );
    expect(screen.getByTestId("father-session")).toHaveAttribute("data-error", "");
  });

  it("says how to name one when no Bot does, and closes", () => {
    const onClose = vi.fn();
    render(<FatherOverlay {...PROPS} bots={[]} onClose={onClose} />);
    expect(screen.getByText(/No Bot names a Father session/)).toBeDefined();
    expect(screen.queryByTestId("father-session")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close the Father home" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers the detach for a Father the catalog forgot", () => {
    const onDetachSession = vi.fn();
    const gone = bot("a", {
      sessions: [],
      fatherSession: { source: "opencode", sessionId: "s1" },
    });
    render(<FatherOverlay {...PROPS} bots={[gone]} onDetachSession={onDetachSession} />);
    expect(screen.getByRole("alert")).toHaveTextContent("opencode:s1");
    expect(screen.queryByTestId("father-session")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Detach it/ }));
    expect(onDetachSession).toHaveBeenCalledWith(gone, { source: "opencode", sessionId: "s1" });
  });
});
