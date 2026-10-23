import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  DICTATION_LABEL,
  resetDeviceMic,
  startDeviceMic,
  stopDeviceMic,
  useDeviceMic,
  useDeviceMicHearing,
  useDeviceMicSink,
  withDictation,
} from "@/features/session-view/composer/deviceMic";

/** The browser's recognizer, which the test speaks for. */
class FakeRecognizer {
  static made: FakeRecognizer[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  started = false;
  aborted = false;
  constructor() {
    FakeRecognizer.made.push(this);
  }
  start() {
    this.started = true;
  }
  abort() {
    this.aborted = true;
    this.onend?.();
  }
  /** Results from `resultIndex` on, each `[words, confidence, finished]`. */
  hear(resultIndex: number, ...results: [string, number, boolean][]) {
    const list = results.map(([transcript, confidence, isFinal]) =>
      Object.assign([{ transcript, confidence }], { isFinal }),
    );
    this.onresult?.({ resultIndex, results: [...Array<undefined>(resultIndex), ...list] });
  }
}

const latest = () => FakeRecognizer.made.at(-1)!;

beforeEach(() => {
  FakeRecognizer.made = [];
  vi.stubGlobal("webkitSpeechRecognition", FakeRecognizer);
});

afterEach(() => {
  resetDeviceMic();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("what dictation adds to a composer", () => {
  it("labels the first piece, quotes each one, and strikes through what it was unsure of", () => {
    const first = withDictation("", " fix the build ", 0.9);
    expect(first).toBe(`${DICTATION_LABEL} "fix the build"`);
    const second = withDictation(first, 'say "hi"', 0.3);
    expect(second).toBe(`${first} "~~say 'hi'~~"`);
    expect(withDictation("my own words ", "then this", 0.9)).toBe(`my own words ${DICTATION_LABEL} "then this"`);
    expect(withDictation("unchanged", "   ", 0.9)).toBe("unchanged");
  });
});

describe("this device's mic", () => {
  it("hands each finished phrase to the composer once, and shows what it is still hearing", () => {
    const add = vi.fn();
    renderHook(() => useDeviceMicSink("a", true, add));
    const state = renderHook(() => useDeviceMic("a"));
    const hearing = renderHook(() => useDeviceMicHearing("a"));
    act(() => startDeviceMic("a"));
    expect(latest()).toMatchObject({ started: true, continuous: true, interimResults: true });
    act(() => latest().onstart?.());
    expect(state.result.current).toMatchObject({ sessionId: "a", listening: true });
    act(() => latest().hear(0, ["hello wor", 0, false]));
    expect(hearing.result.current).toBe("hello wor");
    act(() => latest().hear(0, ["hello world", 0.8, true], ["and", 0, false]));
    expect(add).toHaveBeenCalledWith("hello world", 0.8);
    expect(hearing.result.current).toBe("and");
    // WebKit reports a finished phrase again; it goes in once.
    act(() => latest().hear(0, ["hello world", 0.8, true]));
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("goes to the composer registered last for the session", () => {
    const first = vi.fn();
    const second = vi.fn();
    renderHook(() => useDeviceMicSink("a", true, first));
    renderHook(() => useDeviceMicSink("a", true, second));
    act(() => startDeviceMic("a"));
    act(() => latest().hear(0, ["once", 0.9, true]));
    expect(second).toHaveBeenCalledWith("once", 0.9);
    expect(first).not.toHaveBeenCalled();
  });

  it("listens again shortly after a session ends on silence", () => {
    vi.useFakeTimers();
    renderHook(() => useDeviceMicSink("a", true, vi.fn()));
    act(() => startDeviceMic("a"));
    // Chrome ends a session itself after 8 s without speech.
    act(() => vi.advanceTimersByTime(8000));
    act(() => latest().onend?.());
    act(() => vi.advanceTimersByTime(299));
    expect(FakeRecognizer.made).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeRecognizer.made).toHaveLength(2);
    expect(latest().started).toBe(true);
  });

  it("backs off when sessions end as soon as they start, and stops after five in a minute", () => {
    vi.useFakeTimers();
    renderHook(() => useDeviceMicSink("a", true, vi.fn()));
    const state = renderHook(() => useDeviceMic("a"));
    act(() => startDeviceMic("a"));
    for (const [made, wait] of [
      [2, 1000],
      [3, 2000],
      [4, 4000],
      [5, 8000],
    ] as const) {
      act(() => latest().onend?.());
      act(() => vi.advanceTimersByTime(wait - 1));
      expect(FakeRecognizer.made).toHaveLength(made - 1);
      act(() => vi.advanceTimersByTime(1));
      expect(FakeRecognizer.made).toHaveLength(made);
    }
    act(() => latest().onend?.());
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeRecognizer.made).toHaveLength(5);
    expect(state.result.current).toMatchObject({ sessionId: null, failure: expect.stringMatching(/kept ending/) });
  });

  it("stops rather than fight another page that takes the mic", () => {
    vi.useFakeTimers();
    renderHook(() => useDeviceMicSink("a", true, vi.fn()));
    const state = renderHook(() => useDeviceMic("a"));
    act(() => startDeviceMic("a"));
    // What Chrome tells the page whose session it cut off, followed by the end.
    act(() => latest().onerror?.({ error: "aborted" }));
    act(() => latest().onend?.());
    act(() => vi.advanceTimersByTime(10_000));
    expect(FakeRecognizer.made).toHaveLength(1);
    expect(state.result.current).toMatchObject({ sessionId: null, failure: expect.stringMatching(/another tab/) });
  });

  it("stops when the panel goes to the background", () => {
    renderHook(() => useDeviceMicSink("a", true, vi.fn()));
    const state = renderHook(() => useDeviceMic("a"));
    act(() => startDeviceMic("a"));
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    hidden.mockRestore();
    expect(latest().aborted).toBe(true);
    expect(state.result.current).toMatchObject({ sessionId: null, failure: expect.stringMatching(/background/) });
  });

  it("stops after three minutes with no words, and words put that off", () => {
    vi.useFakeTimers();
    renderHook(() => useDeviceMicSink("a", true, vi.fn()));
    const state = renderHook(() => useDeviceMic("a"));
    act(() => startDeviceMic("a"));
    act(() => vi.advanceTimersByTime(2 * 60_000));
    act(() => latest().hear(0, ["still here", 0, false]));
    act(() => vi.advanceTimersByTime(3 * 60_000 - 1));
    expect(state.result.current.sessionId).toBe("a");
    act(() => vi.advanceTimersByTime(1));
    expect(state.result.current).toMatchObject({ sessionId: null, failure: expect.stringMatching(/three minutes/) });
  });

  it("stops when the last composer for its session goes, so it is never left listening unseen", () => {
    const sink = renderHook(() => useDeviceMicSink("a", true, vi.fn()));
    const state = renderHook(() => useDeviceMic("a"));
    act(() => startDeviceMic("a"));
    const recognizer = latest();
    act(() => sink.unmount());
    expect(recognizer.aborted).toBe(true);
    expect(state.result.current.sessionId).toBeNull();
  });

  it("says why it stopped, to the session it was dictating into only", () => {
    renderHook(() => useDeviceMicSink("a", true, vi.fn()));
    const here = renderHook(() => useDeviceMic("a"));
    const other = renderHook(() => useDeviceMic("b"));
    act(() => startDeviceMic("a"));
    act(() => latest().onerror?.({ error: "not-allowed" }));
    expect(here.result.current).toMatchObject({ sessionId: null, failure: expect.stringMatching(/not allowed/) });
    expect(other.result.current.failure).toBeNull();
    // A pause in speech is not a failure.
    act(() => startDeviceMic("a"));
    act(() => latest().onerror?.({ error: "no-speech" }));
    expect(here.result.current).toMatchObject({ sessionId: "a", failure: null });
    act(() => stopDeviceMic());
  });

  it("says so where the browser has no speech recognition", () => {
    vi.stubGlobal("webkitSpeechRecognition", undefined);
    const state = renderHook(() => useDeviceMic("a"));
    act(() => startDeviceMic("a"));
    expect(state.result.current.failure).toMatch(/no speech recognition/);
  });
});
