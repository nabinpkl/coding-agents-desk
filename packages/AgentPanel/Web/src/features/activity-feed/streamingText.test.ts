import { afterEach, describe, expect, test, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { markdownSafePrefix, useProgressiveText } from "./streamingText";

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

describe("markdownSafePrefix", () => {
  test("hides a marker whose closer has not arrived", () => {
    // The case that put asterisks on screen: a reasoning trace opening bolded.
    expect(markdownSafePrefix("**Checking the e")).toBe("");
    expect(markdownSafePrefix("Done. **Then")).toBe("Done. ");
    expect(markdownSafePrefix("A `value")).toBe("A ");
    // A trailing run has no content behind it yet, so waiting costs nothing.
    expect(markdownSafePrefix("Done. **")).toBe("Done. ");
  });

  test("passes through text whose markers are closed", () => {
    expect(markdownSafePrefix("**Topic** and the rest")).toBe("**Topic** and the rest");
    expect(markdownSafePrefix("A `value` here")).toBe("A `value` here");
    expect(markdownSafePrefix("plain words")).toBe("plain words");
  });

  test("leaves a list bullet alone", () => {
    // A line-leading `*` is a bullet, not an opener; cutting at one would hide the
    // item rather than its marker.
    expect(markdownSafePrefix("* one\n* two")).toBe("* one\n* two");
  });

  test("stops holding text back once the opener is far behind", () => {
    // An unmatched marker that old is a literal asterisk, not a closer still coming,
    // and hiding everything after it would stall the reveal for the rest of the run.
    const stale = `a ** ${"word ".repeat(60)}end`;
    expect(markdownSafePrefix(stale)).toBe(stale);
  });

  test("leaves an open fence to the renderer", () => {
    // marked closes a dangling fence itself and renders the block, so the code
    // arrives steadily; counting backticks across the fence would cut inside it.
    const open = "here:\n```ts\nconst x = 1";
    expect(markdownSafePrefix(open)).toBe(open);
  });
});
