import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { resetDictationTarget, targetIn, useDictationTarget } from "@/features/session-view/composer/dictationTarget";
import { composerActions } from "@/features/session-view/composer/sessionComposerActions";
import type { ComposerModel } from "@/features/session-view/composer/sessionComposerModel";

/** The Mac's stream, which the test speaks for. */
class FakeEventSource {
  static open: FakeEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.open.push(this);
  }
  say(sessionId: string | null, mics = 1) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ sessionId, mics }) }));
  }
  close() {
    this.closed = true;
  }
}

function setUp(answer = () => Promise.resolve(Response.json({}))) {
  FakeEventSource.open = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  const fetch = vi.fn((_url: string, _init?: RequestInit) => answer());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetDictationTarget();
});

describe("where the phone's dictation streams", () => {
  it("follows the Mac's choice, one stream for every composer, closed after the last", () => {
    setUp();
    const first = renderHook(() => useDictationTarget("a", true));
    const second = renderHook(() => useDictationTarget("b", true));
    expect(FakeEventSource.open).toHaveLength(1);
    const stream = FakeEventSource.open[0]!;
    expect(stream.url).toBe("/api/audio/dictation-target/stream");
    act(() => stream.say("a"));
    expect(first.result.current).toMatchObject({ here: true, elsewhere: false, mics: 1, known: true });
    expect(second.result.current).toMatchObject({ here: false, elsewhere: true });
    first.unmount();
    expect(stream.closed).toBe(false);
    second.unmount();
    expect(stream.closed).toBe(true);
  });

  it("opens nothing for a composer it cannot reach", () => {
    setUp();
    renderHook(() => useDictationTarget("a", false));
    expect(FakeEventSource.open).toHaveLength(0);
  });

  it("tells the Mac, and leaves another session's stream alone when told not here", async () => {
    const fetch = setUp();
    const { result } = renderHook(() => useDictationTarget("a", true));
    await act(async () => result.current.choose("here"));
    expect(fetch).toHaveBeenCalledWith("/api/audio/dictation-target", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ sessionId: "a" });
    expect(result.current.here).toBe(true);
    act(() => FakeEventSource.open[0]!.say("b"));
    await act(async () => result.current.choose("off"));
    expect(fetch).toHaveBeenCalledTimes(1);
    // Stop is the one that reaches another session's stream.
    await act(async () => result.current.choose("stop"));
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ sessionId: null });
  });

  it("puts the choice back, and says why, when the Mac refuses it", async () => {
    setUp(() => Promise.resolve(new Response(null, { status: 400 })));
    const { result } = renderHook(() => useDictationTarget("a", true));
    await act(async () => result.current.choose("here"));
    await vi.waitFor(() => expect(result.current.failure).toMatch(/400/));
    expect(result.current.here).toBe(false);
  });

  it("says how many phone mics are listening", () => {
    setUp();
    const { result } = renderHook(() => useDictationTarget("a", true));
    act(() => FakeEventSource.open[0]!.say("a", 0));
    expect(result.current).toMatchObject({ here: true, mics: 0 });
    act(() => FakeEventSource.open[0]!.say("a", 2));
    expect(result.current.mics).toBe(2);
  });

  it("reads only this stream's events", () => {
    expect(targetIn('{"sessionId":"a","mics":1}')).toEqual({ sessionId: "a", mics: 1 });
    expect(targetIn('{"sessionId":null,"mics":0}')).toEqual({ sessionId: null, mics: 0 });
    expect(targetIn('{"sessionId":"a"}')).toBeUndefined();
    expect(targetIn('{"other":1}')).toBeUndefined();
    expect(targetIn("null")).toBeUndefined();
    expect(targetIn("not json")).toBeUndefined();
  });
});

describe("the composer's mic", () => {
  const model = (dictation: ComposerModel["dictation"]) =>
    ({ dictation, session: { source: "claude", sessionId: "a" }, editorValue: "" }) as unknown as ComposerModel;

  it("sits in the field with a menu that streams here, not here, or stops", () => {
    const choose = vi.fn();
    const actions = composerActions(
      model({ here: true, elsewhere: false, mics: 1, known: true, failure: null, choose }),
    );
    const mic = actions.find((action) => action.key === "dictation-target");
    expect(mic?.placement).toBe("field");
    expect(mic?.menu?.value).toBe("here");
    expect(mic?.menu?.choices.map((choice) => choice.label)).toEqual([
      "Stream dictation here",
      "Not here",
      "Stop streaming",
    ]);
    mic?.menu?.onChoose("stop");
    expect(choose).toHaveBeenCalledWith("stop");
  });

  it("says when no phone mic is listening to stream", () => {
    const listening = { here: true, elsewhere: false, known: true, failure: null, choose: vi.fn() };
    const silent = composerActions(model({ ...listening, mics: 0 })).find((a) => a.key === "dictation-target");
    expect(silent?.title).toMatch(/no phone mic is listening/);
    expect(silent?.className).toMatch(/amber/);
    expect(silent?.menu?.choices[0]?.description).toMatch(/No phone mic is listening/);
    const heard = composerActions(model({ ...listening, mics: 1 })).find((a) => a.key === "dictation-target");
    expect(heard?.title).toMatch(/a phone mic is listening/);
    expect(heard?.className).not.toMatch(/amber/);
  });

  it("is not there for a session dictation cannot reach", () => {
    expect(composerActions(model(null)).some((action) => action.key === "dictation-target")).toBe(false);
  });
});
