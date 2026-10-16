import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StaleClaudeSession } from "@agentdesk/agent-feed-wire";
import { StaleSessionsPanel } from "@/features/profile/StaleSessionsModal";
import type { StaleSessionsHandle } from "@/features/profile/useStaleSessions";

function session(overrides: Partial<StaleClaudeSession> & { sessionId: string }): StaleClaudeSession {
  return { name: overrides.sessionId, version: "2.1.296", activity: "idle", reasons: ["update"], ownLaunch: false, ...overrides };
}

const SESSIONS = [
  session({ sessionId: "alan", name: "Alan" }),
  session({ sessionId: "brian", name: "Brian", version: "2.1.285", reasons: ["launch-flags", "update"] }),
  session({ sessionId: "clifford", name: "Clifford", activity: "shell" }),
  session({ sessionId: "curtis", name: "Curtis", activity: "busy" }),
  session({ sessionId: "arena", name: "arena manager", reasons: ["launch-flags"], ownLaunch: true }),
];

function handle(overrides: Partial<StaleSessionsHandle> = {}): StaleSessionsHandle {
  return {
    view: { kind: "ready", stale: { installedVersion: "2.1.301", sessions: SESSIONS } },
    action: { kind: "none" },
    load: vi.fn(),
    restart: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("StaleSessionsPanel", () => {
  it("offers only idle sessions the panel launched, and says why each other one is left running", () => {
    render(<StaleSessionsPanel restarts={handle()} onClose={() => {}} />);
    const ready = within(screen.getByRole("region", { name: "Will restart" }));
    expect(ready.getByText("Alan")).toBeTruthy();
    expect(ready.getByText("Brian")).toBeTruthy();
    expect(ready.getByText("2.1.285 → 2.1.301")).toBeTruthy();
    expect(ready.getByText("old flags")).toBeTruthy();

    const left = within(screen.getByRole("region", { name: "Left running" }));
    expect(left.getByText("background shell")).toBeTruthy();
    expect(left.getByText("turn running")).toBeTruthy();
    expect(left.getByText("own launch flags")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Restart 2/ })).toBeTruthy();
  });

  it("restarts on the second press only, with exactly the sessions it offered", () => {
    const restarts = handle();
    render(<StaleSessionsPanel restarts={restarts} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Restart 2/ }));
    expect(restarts.restart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Press again to restart 2/ }));
    expect(restarts.restart).toHaveBeenCalledWith(["alan", "brian"]);
  });

  it("disarms on its own, so a stray press is never a restart later", () => {
    vi.useFakeTimers();
    const restarts = handle();
    render(<StaleSessionsPanel restarts={restarts} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Restart 2/ }));
    act(() => {
      vi.advanceTimersByTime(4_100);
    });
    fireEvent.click(screen.getByRole("button", { name: /Restart 2/ }));
    expect(restarts.restart).not.toHaveBeenCalled();
  });

  it("names every session the restart did not restart, and why", () => {
    render(
      <StaleSessionsPanel
        restarts={handle({
          action: {
            kind: "done",
            results: [
              { sessionId: "alan", name: "Alan", outcome: { kind: "restarted" } },
              { sessionId: "brian", name: "Brian", outcome: { kind: "skipped", reason: "a turn is running" } },
              { sessionId: "dora", name: "Dora", outcome: { kind: "failed", message: "tmux went away" } },
            ],
          },
        })}
        onClose={() => {}}
      />,
    );
    const status = within(screen.getByRole("status"));
    expect(status.getByText("Restarted 1 of 3.")).toBeTruthy();
    expect(status.getByText("Brian: left running, a turn is running")).toBeTruthy();
    expect(status.getByText("Dora: failed, tmux went away")).toBeTruthy();
  });

  it("says so when nothing is behind, and has nothing to press", () => {
    render(
      <StaleSessionsPanel
        restarts={handle({ view: { kind: "ready", stale: { installedVersion: "2.1.301", sessions: [] } } })}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Every session runs the current launch flags and CLI.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Restart 0/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
