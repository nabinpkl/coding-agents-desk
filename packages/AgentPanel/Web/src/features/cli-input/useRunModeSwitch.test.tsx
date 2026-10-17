import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRunModeSwitch } from "@/features/cli-input/useRunModeSwitch";

const SESSION = { source: "claude", sessionId: "s1" };

afterEach(() => vi.useRealTimers());

describe("switching how a session runs", () => {
  it("reads the session again a few times after a switch, while the new process registers", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const feed = { switchClaudeRunMode: vi.fn(async () => ({ ok: true as const })) };
    const { result } = renderHook(() => useRunModeSwitch(feed, SESSION, refresh));
    await act(async () => result.current.switchTo("sdk"));
    expect(feed.switchClaudeRunMode).toHaveBeenCalledWith(SESSION, "sdk");
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(8_000));
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
  });

  it("says a refusal as a sentence and reads nothing again", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const feed = {
      switchClaudeRunMode: vi.fn(async () => ({ ok: false as const, reason: "busy" as const, message: "not switched: a turn is running" })),
    };
    const { result } = renderHook(() => useRunModeSwitch(feed, SESSION, refresh));
    await act(async () => result.current.switchTo("terminal"));
    expect(result.current.error).toBe("Not switched: a turn is running.");
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(refresh).not.toHaveBeenCalled();
  });
});
