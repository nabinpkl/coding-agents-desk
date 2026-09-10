import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { CliInputStatus } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "@/features/activity-feed/data-source/SidecarDataSource";
import { cliInputReasonText, useCliInput } from "@/features/cli-input/useCliInput";

const TERMINAL: CliInputStatus = {
  available: true, entrypoint: "cli", reason: null, tmuxSession: "keyboard",
};
const DESKTOP: CliInputStatus = {
  available: true, entrypoint: "claude-desktop", reason: null, tmuxSession: null,
};
const GONE: CliInputStatus = {
  available: false, entrypoint: null, reason: "not-running", tmuxSession: null,
};

const S1: SessionAddress = { source: "claude", sessionId: "s1" };
const S2: SessionAddress = { source: "claude", sessionId: "s2" };

function Probe(
  { feed, session, active = true }: {
    feed: Parameters<typeof useCliInput>[0];
    session: SessionAddress | null;
    active?: boolean;
  },
) {
  const cliInput = useCliInput(feed, session, active);
  return (
    <div>
      <span data-testid="terminal">{String(cliInput.isTerminalSession)}</span>
      <span data-testid="available">{String(cliInput.available)}</span>
      <span data-testid="reason">{cliInput.reason ?? "-"}</span>
      <button type="button" onClick={() => void cliInput.send("hello")}>send</button>
      <button type="button" onClick={cliInput.refresh}>refresh</button>
    </div>
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

const press = async (name: string) => {
  await act(async () => {
    screen.getByText(name).click();
    await Promise.resolve();
  });
};

describe("useCliInput", () => {
  it("recognises a session running in a terminal", async () => {
    const feed = { cliInputStatus: vi.fn().mockResolvedValue(TERMINAL), sendCliInput: vi.fn() };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    expect(screen.getByTestId("terminal").textContent).toBe("true");
    expect(screen.getByTestId("available").textContent).toBe("true");
  });

  it("does not claim a Desktop session as a terminal one, even though it has an inbox", async () => {
    // The inbox exists for both launch surfaces. Only the terminal one has no window field to
    // mirror, and it is the window composer that must keep serving the other.
    const feed = { cliInputStatus: vi.fn().mockResolvedValue(DESKTOP), sendCliInput: vi.fn() };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    expect(screen.getByTestId("terminal").textContent).toBe("false");
  });

  it("asks nothing at all for a source that has no inbox", async () => {
    const feed = { cliInputStatus: vi.fn().mockResolvedValue(TERMINAL), sendCliInput: vi.fn() };
    render(<Probe feed={feed} session={{ source: "pi", sessionId: "p1" }} active={false} />);
    await flush();
    expect(feed.cliInputStatus).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal").textContent).toBe("false");
  });

  it("re-reads on the session it is asked about, and drops an answer for the previous one", async () => {
    // The failure this prevents is a composer enabled for a thread nobody is looking at: the
    // slow answer for s1 lands after the viewer has moved to s2.
    let settleFirst: ((value: CliInputStatus) => void) | undefined;
    const feed = {
      cliInputStatus: vi.fn()
        .mockImplementationOnce(() => new Promise<CliInputStatus>((r) => { settleFirst = r; }))
        .mockResolvedValue(GONE),
      sendCliInput: vi.fn(),
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
    expect(screen.getByTestId("reason").textContent).toBe("not-running");
  });

  it("a refused turn updates the status from the receipt, keeping the band it is in", async () => {
    const feed = {
      cliInputStatus: vi.fn().mockResolvedValue(TERMINAL),
      sendCliInput: vi.fn().mockResolvedValue({ delivered: false, reason: "unreachable" }),
    };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    await press("send");
    expect(screen.getByTestId("available").textContent).toBe("false");
    expect(screen.getByTestId("reason").textContent).toBe("unreachable");
    // Still a terminal session: it stopped running, it did not become a window.
    expect(screen.getByTestId("terminal").textContent).toBe("true");
  });

  it("a delivered turn leaves the status alone", async () => {
    const feed = {
      cliInputStatus: vi.fn().mockResolvedValue(TERMINAL),
      sendCliInput: vi.fn().mockResolvedValue({ delivered: true, reason: null }),
    };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    await press("send");
    expect(screen.getByTestId("available").textContent).toBe("true");
  });

  it("refresh re-asks, which is how a session started after the panel opened becomes writable", async () => {
    const feed = {
      cliInputStatus: vi.fn()
        .mockResolvedValueOnce(GONE)
        .mockResolvedValue(TERMINAL),
      sendCliInput: vi.fn(),
    };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    expect(screen.getByTestId("available").textContent).toBe("false");
    await press("refresh");
    expect(screen.getByTestId("available").textContent).toBe("true");
  });

  it("a failed read leaves a working composer working", async () => {
    // One dropped request must not collapse the field to unavailable; the panel's own connection
    // state is what says the sidecar is gone.
    const feed = {
      cliInputStatus: vi.fn()
        .mockResolvedValueOnce(TERMINAL)
        .mockRejectedValue(new Error("offline")),
      sendCliInput: vi.fn(),
    };
    render(<Probe feed={feed} session={S1} />);
    await flush();
    await press("refresh");
    expect(screen.getByTestId("available").textContent).toBe("true");
  });
});

describe("cliInputReasonText", () => {
  it("says what to do about it, not what the code called it", () => {
    expect(cliInputReasonText("not-running")).toContain("Start it in a terminal");
    expect(cliInputReasonText("unreachable")).toContain("exited");
  });
});
