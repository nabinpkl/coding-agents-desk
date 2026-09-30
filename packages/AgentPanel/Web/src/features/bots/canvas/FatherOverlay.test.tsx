/**
 * Which session the Father home shows, what it says while it cannot show one, and where it stands
 * relative to the switch that opens it.
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
  it("stays on screen while the home is open, and says so", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<FatherButton open={false} onToggle={onToggle} />);
    const button = screen.getByRole("button", { name: "Father" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveAttribute("aria-controls", "father-home");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);

    // Open: still there, still the same button, and now saying that it is expanded -- so the
    // state is on the page rather than only in the drawer's own X.
    rerender(<FatherButton open onToggle={onToggle} />);
    const open = screen.getByRole("button", { name: "Father" });
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(open).toHaveAttribute("aria-controls", "father-home");
    expect(open).toHaveAttribute("title", "Put the Father home away");
    fireEvent.click(open);
    expect(onToggle).toHaveBeenCalledTimes(2);
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

  it("carries by the header background and remembers the stand", () => {
    render(<FatherOverlay {...PROPS} />);
    const header = screen.getByRole("heading", { name: "Father" }).parentElement!;
    fireEvent.pointerDown(header, { pointerId: 1, clientX: 100, clientY: 20, bubbles: true });
    // A two-pixel wobble is a click, not a carry: nothing moves and nothing is stored.
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 102, clientY: 21, bubbles: true });
    fireEvent.pointerUp(header, { pointerId: 1, clientX: 102, clientY: 21, bubbles: true });
    expect(localStorage.getItem("agent-panel.bot-canvas.father-position")).toBeNull();

    fireEvent.pointerDown(header, { pointerId: 2, clientX: 100, clientY: 20, bubbles: true });
    fireEvent.pointerMove(header, { pointerId: 2, clientX: 160, clientY: 70, bubbles: true });
    fireEvent.pointerUp(header, { pointerId: 2, clientX: 160, clientY: 70, bubbles: true });
    // jsdom measures nothing, so the stand starts at the origin and follows the pointer.
    expect(screen.getByRole("region", { name: "Father home" }).style.left).toBe("60px");
    expect(localStorage.getItem("agent-panel.bot-canvas.father-position")).toBe(
      JSON.stringify({ x: 60, y: 50 }),
    );
  });

  it("never carries a press that began on a control", () => {
    render(<FatherOverlay {...PROPS} />);
    const close = screen.getByRole("button", { name: "Close the Father home" });
    fireEvent.pointerDown(close, { pointerId: 3, clientX: 800, clientY: 20, bubbles: true });
    fireEvent.pointerMove(close, { pointerId: 3, clientX: 900, clientY: 120, bubbles: true });
    fireEvent.pointerUp(close, { pointerId: 3, clientX: 900, clientY: 120, bubbles: true });
    expect(localStorage.getItem("agent-panel.bot-canvas.father-position")).toBeNull();
  });

  it("says how to name one when no Bot does, and closes", () => {
    const onClose = vi.fn();
    render(<FatherOverlay {...PROPS} bots={[]} onClose={onClose} />);
    expect(screen.getByText(/No Bot names a Father session/)).toBeDefined();
    expect(screen.queryByTestId("father-session")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close the Father home" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a pointer landing outside it, and not on one inside", () => {
    const onClose = vi.fn();
    render(<FatherOverlay {...PROPS} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByTestId("father-session"), { bubbles: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body, { bubbles: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a portal menu the session opened from counting as outside", () => {
    const onClose = vi.fn();
    render(<FatherOverlay {...PROPS} onClose={onClose} />);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.textContent = "Father action";
    document.body.appendChild(menu);
    fireEvent.pointerDown(menu, { bubbles: true });
    expect(onClose).not.toHaveBeenCalled();
    menu.remove();
  });

  it("hangs below its switch, which is what leaves the switch reachable", () => {
    // The switch's own box, since jsdom measures nothing: 4px down a 44px bar, so a bottom edge
    // at 40 and a drawer resting 4px below it.
    const measured = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function patched(this: Element) {
      if (this.getAttribute("aria-controls") === "father-home") {
        return { x: 0, y: 4, width: 91, height: 36, top: 4, left: 0, right: 91, bottom: 40, toJSON: () => ({}) };
      }
      return measured.call(this);
    };
    try {
      render(
        <>
          <FatherButton open onToggle={() => undefined} />
          <FatherOverlay {...PROPS} />
        </>,
      );
      const home = screen.getByRole("region", { name: "Father home" });
      expect(home.style.top).toBe("44px");
      // Right edge still pinned, so the width grip keeps growing the drawer leftwards.
      expect(home.style.left).toBe("");
      expect(home.className).toContain("right-0");
    } finally {
      Element.prototype.getBoundingClientRect = measured;
    }
  });

  it("does not treat a press on its own switch as leaving", () => {
    // The switch both opens and closes this, so dismissing on the press and toggling on the click
    // would shut the home and open it again in one gesture.
    const onClose = vi.fn();
    render(
      <>
        <FatherButton open onToggle={onClose} />
        <FatherOverlay {...PROPS} onClose={onClose} />
      </>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Father" }), { bubbles: true });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body, { bubbles: true });
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
