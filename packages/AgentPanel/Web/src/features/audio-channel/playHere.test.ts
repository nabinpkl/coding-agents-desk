import { afterEach, describe, expect, it, vi } from "vitest";
import { playHere } from "@/features/audio-channel/playHere";

/** A stand-in for Web Audio: records what is scheduled, and when each piece starts. */
function fakeContext() {
  const started: { at: number; samples: number[] }[] = [];
  const sources: { onended: (() => void) | null }[] = [];
  const context = {
    currentTime: 0,
    destination: {},
    closed: false,
    resume: () => Promise.resolve(),
    close() {
      context.closed = true;
      return Promise.resolve();
    },
    createBuffer(_channels: number, length: number, rate: number) {
      const data = new Float32Array(length);
      return { duration: length / rate, copyToChannel: (from: Float32Array) => data.set(from), data };
    },
    createBufferSource() {
      const source = {
        buffer: null as { data: Float32Array } | null,
        onended: null as (() => void) | null,
        connect: () => undefined,
        start(at: number) {
          started.push({ at, samples: Array.from(source.buffer?.data ?? []) });
        },
      };
      sources.push(source);
      return source;
    },
  };
  return { context, started, sources, make: () => context as unknown as AudioContext };
}

/** A response whose body arrives in the pieces given, split wherever the test likes. */
function streamed(pieces: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(piece);
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function bytesOf(samples: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(samples).buffer);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playing a reply on this device", () => {
  it("asks this Mac for it and plays the samples back to back, whatever the network split", async () => {
    const audio = fakeContext();
    const bytes = bytesOf([0.5, -0.25, 0.125]);
    // Split inside a sample, as a network may.
    const fetch = vi.fn(() => Promise.resolve(streamed([bytes.slice(0, 5), bytes.slice(5)])));
    vi.stubGlobal("fetch", fetch);
    const playback = playHere("It works.", audio.make);
    await vi.waitFor(() => expect(audio.started).toHaveLength(1));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/speech/here");
    expect(JSON.parse(String(init.body))).toMatchObject({ text: "It works." });
    expect(audio.started[0]?.samples).toEqual([0.5, -0.25, 0.125]);
    audio.sources[0]?.onended?.();
    expect(await playback.finished).toEqual({ state: "played" });
    expect(audio.context.closed).toBe(true);
  });

  it("stops at once, and tells the Mac to stop making the rest", async () => {
    const audio = fakeContext();
    const fetch = vi.fn((url: string) =>
      url === "/api/speech/here/stop"
        ? Promise.resolve(new Response(null, { status: 204 }))
        : new Promise<Response>(() => undefined),
    );
    vi.stubGlobal("fetch", fetch);
    const playback = playHere("Long.", audio.make);
    const ref = (
      JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { ref: string }
    ).ref;
    playback.stop();
    expect(await playback.finished).toEqual({ state: "stopped" });
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/speech/here/stop");
    expect(JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ ref });
    expect(audio.context.closed).toBe(true);
  });

  it("stops the one playing when another starts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const first = playHere("One.", fakeContext().make);
    playHere("Two.", fakeContext().make);
    expect(await first.finished).toEqual({ state: "stopped" });
  });

  it("says why when the Mac had nothing to play", async () => {
    const body = { error: { code: "nothing_to_say", message: "x" } };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 422 }))),
    );
    expect(await playHere("```", fakeContext().make).finished).toEqual({
      state: "failed",
      reason: "nothing in it can be read out loud",
    });
  });
});
