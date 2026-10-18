import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StaleClaudeSessions } from "@agentdesk/agent-feed-wire";
import { resetStaleSessions, useStaleSessions, type StaleSessionsMachine } from "@/features/profile/useStaleSessions";

const STALE: StaleClaudeSessions = {
  installedVersion: "2.1.301",
  sessions: [
    { sessionId: "a", name: "A", version: "2.1.296", activity: "idle", reasons: ["update"], ownLaunch: false },
  ],
};

function feed(stale: () => Promise<StaleClaudeSessions>) {
  return {
    staleSessions: vi.fn(stale),
    restartStaleSessions: vi.fn(async (ids: readonly string[]) =>
      ids.map((sessionId) => ({ sessionId, name: null, outcome: { kind: "restarted" as const } })),
    ),
  };
}

// The store is the page's, so what one test read must not be what the next one starts from.
afterEach(resetStaleSessions);

describe("useStaleSessions", () => {
  it("reads every machine on its own sidecar, and one that fails does not hide the others", async () => {
    const home = feed(async () => STALE);
    const peer = feed(async () => {
      throw new Error("sidecar did not answer");
    });
    const machines: StaleSessionsMachine[] = [
      { label: "dev", feed: home },
      { id: "oracle", label: "oracle", feed: peer },
    ];
    const { result } = renderHook(() => useStaleSessions(machines));
    expect(result.current.machines.map((machine) => machine.view.kind)).toEqual(["idle", "idle"]);

    act(() => result.current.load());
    await waitFor(() =>
      expect(result.current.machines.map((machine) => machine.view.kind)).toEqual(["ready", "failed"]),
    );
    expect(result.current.machines.map(({ key, label }) => ({ key, label }))).toEqual([
      { key: "", label: "dev" },
      { key: "oracle", label: "oracle" },
    ]);
  });

  it("restarts each machine's sessions on that machine only, then reads its list again", async () => {
    const home = feed(async () => STALE);
    const peer = feed(async () => STALE);
    const machines: StaleSessionsMachine[] = [
      { label: "dev", feed: home },
      { id: "oracle", label: "oracle", feed: peer },
    ];
    const { result } = renderHook(() => useStaleSessions(machines));

    act(() =>
      result.current.restart(
        new Map([
          ["oracle", ["a"]],
          ["", []],
        ]),
      ),
    );
    await waitFor(() => expect(result.current.machines[1]!.action.kind).toBe("done"));
    expect(peer.restartStaleSessions).toHaveBeenCalledWith(["a"]);
    // A machine with nothing to restart is not asked to restart nothing.
    expect(home.restartStaleSessions).not.toHaveBeenCalled();
    expect(result.current.machines[0]!.action.kind).toBe("none");
    await waitFor(() => expect(peer.staleSessions).toHaveBeenCalledTimes(1));
    expect(home.staleSessions).not.toHaveBeenCalled();
  });

  it("reads a machine that joins after the lists were asked for, and not before", async () => {
    const home = feed(async () => STALE);
    const peer = feed(async () => STALE);
    const homeOnly: StaleSessionsMachine[] = [{ label: "dev", feed: home }];
    const both: StaleSessionsMachine[] = [...homeOnly, { id: "oracle", label: "oracle", feed: peer }];
    const { result, rerender } = renderHook(({ all }) => useStaleSessions(all), { initialProps: { all: homeOnly } });
    // The live index names the peer a moment after mount; nobody has asked yet, so nothing is read.
    rerender({ all: both });
    expect(peer.staleSessions).not.toHaveBeenCalled();

    rerender({ all: homeOnly });
    act(() => result.current.load());
    rerender({ all: both });
    await waitFor(() => expect(result.current.machines[1]!.view.kind).toBe("ready"));
    expect(peer.staleSessions).toHaveBeenCalledTimes(1);
    expect(home.staleSessions).toHaveBeenCalledTimes(1);
  });

  // The Profile row is drawn by every sidebar mount, and the phone drawer and the hover preview
  // come and go. What one of them read is what the next one shows, which is why this is a store
  // rather than state inside whichever row asked.
  it("keeps what was read after the reader that asked has gone", async () => {
    const home = feed(async () => STALE);
    const machines: StaleSessionsMachine[] = [{ label: "dev", feed: home }];
    const first = renderHook(() => useStaleSessions(machines));
    act(() => first.result.current.load());
    await waitFor(() => expect(first.result.current.machines[0]!.view.kind).toBe("ready"));
    first.unmount();

    const next = renderHook(() => useStaleSessions(machines));
    expect(next.result.current.machines[0]!.view.kind).toBe("ready");
    expect(home.staleSessions).toHaveBeenCalledTimes(1);
  });
});
