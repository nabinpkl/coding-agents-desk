import { afterEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useProgressiveText } from "./streamingText";

afterEach(() => {
  vi.useRealTimers();
});

describe("useProgressiveText", () => {
  test("shows nothing initially and reveals text progressively while streaming", () => {
    vi.useFakeTimers();
    const view = renderHook(({ text, streaming }) => useProgressiveText(text, streaming), {
      initialProps: { text: "hello world", streaming: true },
    });
    expect(view.result.current).toBe("");

    // Advance a bounded number of ticks; the reveal must complete rather than hang.
    for (let i = 0; i < 100; i++) {
      act(() => vi.advanceTimersByTime(33));
      if (view.result.current === "hello world") break;
    }
    expect(view.result.current).toBe("hello world");
  });

  test("snaps to full text immediately when streaming ends", () => {
    vi.useFakeTimers();
    const view = renderHook(({ text, streaming }) => useProgressiveText(text, streaming), {
      initialProps: { text: "partial hello", streaming: true },
    });
    act(() => vi.advanceTimersByTime(10));
    expect(view.result.current.length).toBeLessThan("partial hello".length);

    view.rerender({ text: "partial hello", streaming: false });
    expect(view.result.current).toBe("partial hello");
  });

  test("renders a completed block as full text from the start", () => {
    const view = renderHook(({ text, streaming }) => useProgressiveText(text, streaming), {
      initialProps: { text: "done", streaming: false },
    });
    expect(view.result.current).toBe("done");
  });

  test("keeps the reveal position across growing revisions", () => {
    vi.useFakeTimers();
    const view = renderHook(({ text, streaming }) => useProgressiveText(text, streaming), {
      initialProps: { text: "a longer", streaming: true },
    });
    act(() => vi.advanceTimersByTime(33));
    // Some prefix has been revealed but not the whole run yet.
    const revealedBeforeGrow = view.result.current;
    expect(revealedBeforeGrow.length).toBeGreaterThan(0);

    view.rerender({ text: "a longer message indeed", streaming: true });
    for (let i = 0; i < 100; i++) {
      act(() => vi.advanceTimersByTime(33));
      if (view.result.current.length === "a longer message indeed".length) break;
    }
    expect(view.result.current).toBe("a longer message indeed");
  });
});