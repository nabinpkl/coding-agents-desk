import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { DesktopNavigationState } from "@agentdesk/agent-feed-wire";
import { useDesktopNavigation } from "@/features/desktop-viewer/navigation/useDesktopNavigation";

const snapshot: DesktopNavigationState = {
  type: "desktop-state", revision: 1, captureDisplayId: "A", displays: [{
    id: "A", label: "Main", isMain: true, activeSpaceId: "1",
    spaces: [{ id: "1", type: 0 }, { id: "2", type: 4 }, { id: "3", type: 0 }],
  }],
};
function setup() {
  vi.useFakeTimers();
  const send = vi.fn(() => "sent" as const);
  const abort = vi.fn();
  const transport = { send, abort };
  const report = vi.fn();
  const hook = renderHook(() => useDesktopNavigation({ transport, displayId: "A", report }));
  act(() => hook.result.current.handleEvent(snapshot));
  send.mockClear();
  return { ...hook, send, abort, report };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("desktop navigation lifecycle", () => {
  it("uses the exact ID for taps, ignores intermediate states, and settles only at the target", () => {
    const { result, send, report } = setup();
    act(() => result.current.select("3"));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "space-select", spaceId: "3", displayId: "A" }));
    expect(result.current.model.motion.kind).toBe("pending");
    act(() => result.current.handleEvent({ ...snapshot, revision: 2,
      displays: [{ ...snapshot.displays[0], activeSpaceId: "2" }] }));
    expect(result.current.model.motion.kind).toBe("pending");
    act(() => result.current.handleEvent({ ...snapshot, revision: 3,
      displays: [{ ...snapshot.displays[0], activeSpaceId: "3" }] }));
    expect(result.current.model.motion.kind).toBe("idle");
    expect(report).toHaveBeenCalledWith("navigation-settled", expect.objectContaining({ reached: true }));
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.model.error).toBeNull();
  });
  it("replaces timeouts and never treats stale rejection as the new request", () => {
    const { result, send } = setup();
    act(() => result.current.select("3"));
    const old = result.current.model.motion;
    act(() => vi.advanceTimersByTime(1500));
    act(() => result.current.select("3"));
    act(() => {
      if (old.kind === "pending") result.current.handleEvent({ type: "space-result",
        requestId: old.id, status: "rejected", reason: "space-unavailable" });
      vi.advanceTimersByTime(600);
    });
    expect(result.current.model.motion.kind).toBe("pending");
    act(() => vi.advanceTimersByTime(1400));
    expect(result.current.model.error).toBe("Desktop switch timed out");
    expect(send).toHaveBeenLastCalledWith({ type: "desktop-refresh" });
  });
  it("cancels short drags with phase cancelled rather than zero ended", () => {
    const { result, send } = setup();
    act(() => { result.current.begin(); result.current.end(-20, 900, 400, false); });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: "space-gesture", phase: "cancelled" }));
    expect(result.current.model.motion.kind).toBe("idle");
  });
  it("swipes through the full OS sequence and cancels an external active-space change", () => {
    const { result, send } = setup();
    act(() => { result.current.begin(); result.current.end(-210, -900, 400, false); });
    expect(result.current.model.motion).toMatchObject({ kind: "pending", target: "2" });
    act(() => result.current.begin());
    act(() => result.current.handleEvent({ ...snapshot, revision: 2,
      displays: [{ ...snapshot.displays[0], activeSpaceId: "2" }] }));
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "cancelled" }));
    expect(result.current.model.motion.kind).toBe("idle");
  });
  it("clears queued changes on revocation without reacquiring and cancels on unmount", () => {
    const { result, send, unmount } = setup();
    act(() => { result.current.begin(); result.current.move(-10, -100, 400, false); });
    send.mockClear();
    act(() => result.current.handleEvent({ type: "control-revoked", epoch: 2 }));
    act(() => vi.advanceTimersByTime(50));
    expect(send).not.toHaveBeenCalled();
    act(() => result.current.begin());
    unmount();
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "cancelled" }));
  });
  it("cancels on page blur and never replays when visible again", () => {
    const { result, send } = setup();
    act(() => result.current.begin());
    act(() => window.dispatchEvent(new Event("blur")));
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "cancelled" }));
    send.mockClear();
    act(() => window.dispatchEvent(new Event("focus")));
    expect(send).not.toHaveBeenCalled();
  });
});
