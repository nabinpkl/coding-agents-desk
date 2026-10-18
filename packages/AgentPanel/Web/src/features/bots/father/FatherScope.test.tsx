/**
 * The Father home standing on its own pipeline: bot records in, no canvas.
 *
 * `useBots` is the seam -- the records stream, without any arrangement -- so it is mocked and
 * the feeds behind each machine are spies. `SessionView` is stubbed the way the overlay's own
 * tests stub it: the live session surface is asserted on the live panel, not here.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { FatherScope } from "@/features/bots/father/FatherScope";

vi.mock("@/features/session-view/SessionView", () => ({
  SessionView: (props: { session: SessionSummary; onAttachSession?: (session: unknown) => void }) => (
    <div data-testid="father-session">
      {props.session.sessionId}
      <button
        type="button"
        onClick={() => props.onAttachSession?.({ source: "opencode", sessionId: "s9", title: "Ninth" })}
      >
        attach-probe
      </button>
    </div>
  ),
}));

const mockUseBots = vi.fn();
vi.mock("@/features/bots/useBots", () => ({
  useBots: (...args: unknown[]) => mockUseBots(...args),
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
  sessions: [session("opencode", "s1", "First")],
  fatherSession: { source: "opencode", sessionId: "s1" },
});

const PEER = { label: "oracle", feed: { addBotSessions: vi.fn(), detachBotSessions: vi.fn() } };
const HOME = { addBotSessions: vi.fn(), detachBotSessions: vi.fn() };

function arrange(bots: BotView[], loading = false, machineOf: (botId: string) => unknown = () => undefined) {
  // The index is what the home reads while rendering, and `machineOf` what its commands read.
  const bot = new Map(
    bots.flatMap((each) => {
      const machine = machineOf(each.botId);
      return machine === undefined ? [] : [[each.botId, machine] as const];
    }),
  );
  mockUseBots.mockReturnValue({ bots, loading, machineOf, machineIndex: { bots, bot, session: new Map() } });
}

const PROPS = {
  feed: HOME as never,
  host: {} as never,
  machines: [{ label: "home", feed: HOME }] as never,
  open: true,
  onClose: () => undefined,
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("FatherScope", () => {
  it("renders nothing while shut", () => {
    arrange([FATHER]);
    render(<FatherScope {...PROPS} open={false} />);
    expect(screen.queryByTestId("father-session")).toBeNull();
    expect(screen.queryByRole("region", { name: "Father home" })).toBeNull();
  });

  it("waits for the records rather than announcing that none names one", () => {
    arrange([], true);
    render(<FatherScope {...PROPS} />);
    expect(screen.queryByRole("region", { name: "Father home" })).toBeNull();
  });

  it("shows the declared session once the records arrive", () => {
    arrange([FATHER]);
    render(<FatherScope {...PROPS} />);
    expect(screen.getByTestId("father-session")).toHaveTextContent("s1");
  });

  it("sends attach and detach at the Father's own machine", async () => {
    arrange([FATHER], false, (botId) => (botId === "a" ? PEER : undefined));
    const { detachBotSessions, addBotSessions } = PEER.feed;
    render(<FatherScope {...PROPS} />);

    fireEvent.click(screen.getByRole("button", { name: "attach-probe" }));
    expect(addBotSessions).toHaveBeenCalledWith("a", {
      sessionRefs: [{ source: "opencode", sessionId: "s9" }],
    });

    const gone = bot("a", { sessions: [], fatherSession: { source: "opencode", sessionId: "s1" } });
    arrange([gone], false, (botId) => (botId === "a" ? PEER : undefined));
    cleanup();
    render(<FatherScope {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: /Detach it/ }));
    await waitFor(() => {
      expect(detachBotSessions).toHaveBeenCalledWith("a", {
        sessionRefs: [{ source: "opencode", sessionId: "s1" }],
      });
    });
  });

  it("names a detach that failed on the session it was about", async () => {
    const failing = { ...PEER.feed, detachBotSessions: vi.fn().mockRejectedValue(new Error("gone")) };
    arrange([bot("a", { sessions: [], fatherSession: { source: "opencode", sessionId: "s1" } })], false, (botId) =>
      botId === "a" ? { label: "oracle", feed: failing } : undefined,
    );
    render(<FatherScope {...PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: /Detach it/ }));
    await waitFor(() => {
      expect(screen.getByText("Could not remove s1 from a: gone")).toBeDefined();
    });
  });
});
