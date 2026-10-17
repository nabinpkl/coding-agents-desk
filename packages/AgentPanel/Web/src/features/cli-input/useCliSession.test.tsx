import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { CliSessionStatus } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useCliSession } from "@/features/cli-input/useCliSession";

const TERMINAL: CliSessionStatus = { entrypoint: "cli", tmuxSession: "keyboard" };
const DESKTOP: CliSessionStatus = { entrypoint: "claude-desktop", tmuxSession: null };
const GONE: CliSessionStatus = { entrypoint: null, tmuxSession: null };

const S1: SessionAddress = { source: "claude", sessionId: "s1" };
const S2: SessionAddress = { source: "claude", sessionId: "s2" };

function Probe(
  { feed, session, active = true }: {
    feed: Parameters<typeof useCliSession>[0];
    session: SessionAddress | null;
    active?: boolean;
  },
) {
  const cliSession = useCliSession(feed, session, active);
  return <span data-testid="terminal">{String(cliSession.isTerminalSession)}</span>;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useCliSession", () => {
  it("recognises a session running in a terminal", async () => {
    render(<Probe feed={{ cliSessionStatus: vi.fn().mockResolvedValue(TERMINAL) }} session={S1} />);
    await flush();
    expect(screen.getByTestId("terminal").textContent).toBe("true");
  });

  it("does not claim a Desktop session as a terminal one", async () => {
    render(<Probe feed={{ cliSessionStatus: vi.fn().mockResolvedValue(DESKTOP) }} session={S1} />);
    await flush();
    expect(screen.getByTestId("terminal").textContent).toBe("false");
  });

  it("asks nothing at all when it is not active", async () => {
    const feed = { cliSessionStatus: vi.fn().mockResolvedValue(TERMINAL) };
    render(<Probe feed={feed} session={{ source: "pi", sessionId: "p1" }} active={false} />);
    await flush();
    expect(feed.cliSessionStatus).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal").textContent).toBe("false");
  });

  it("re-reads for the session it is asked about, and drops an answer for the previous one", async () => {
    // The failure this prevents is a composer chosen for a thread nobody is looking at: the slow
    // answer for s1 lands after the viewer has moved to s2.
    let settleFirst: ((value: CliSessionStatus) => void) | undefined;
    const feed = {
      cliSessionStatus: vi.fn()
        .mockImplementationOnce(() => new Promise<CliSessionStatus>((r) => { settleFirst = r; }))
        .mockResolvedValue(GONE),
    };
    const view = render(<Probe feed={feed} session={S1} />);
    await flush();
    view.rerender(<Probe feed={feed} session={S2} />);
    await flush();
    await act(async () => {
      settleFirst?.(TERMINAL);
      await Promise.resolve();
    });
    expect(screen.getByTestId("terminal").textContent).toBe("false");
  });

  it("a failed read leaves the answer it had", async () => {
    const feed = { cliSessionStatus: vi.fn().mockRejectedValue(new Error("offline")) };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    expect(screen.getByTestId("terminal").textContent).toBe("false");
  });
});
