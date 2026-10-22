import { afterEach, describe, expect, it, vi } from "vitest";
import { createRadioListener, type VoicePort } from "@/features/audio-channel/radioListener";
import { createFrameReader, type RadioFrame } from "@/features/audio-channel/radioFrames";

/** One frame as the speech process writes it. */
function frameBytes(header: object, samples: number[] = []): Uint8Array {
  const head = new TextEncoder().encode(JSON.stringify(header));
  const pcm = new Uint8Array(new Float32Array(samples).buffer);
  const out = new Uint8Array(8 + head.length + pcm.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, head.length, true);
  out.set(head, 4);
  view.setUint32(4 + head.length, pcm.length, true);
  out.set(pcm, 8 + head.length);
  return out;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

/** The Mac's two streams, held open for the test to write to, and its speed. */
function fakeMac(speed = 1.25) {
  let push: ReadableStreamDefaultController<Uint8Array> | null = null;
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith("/api/audio/speech-speed")) return Promise.resolve(Response.json({ speed }));
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (url.startsWith("/api/audio/speech-listen")) push = controller;
        },
      });
      resolve(new Response(body, { status: 200 }));
    });
  });
  return { fetch, send: (bytes: Uint8Array) => push?.enqueue(bytes) };
}

function setUp(storage = memoryStorage()) {
  const posted: { type: string; message?: number; made?: number; value?: number }[] = [];
  const voice: VoicePort = { postMessage: (message) => posted.push(message as (typeof posted)[number]) };
  const context = { resume: () => Promise.resolve(), close: vi.fn(() => Promise.resolve()) };
  const listener = createRadioListener({
    makeContext: () => context as unknown as AudioContext,
    makeVoice: () => Promise.resolve(voice),
    storage,
  });
  return { listener, posted, context, storage };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listening to Agent Radio in the panel", () => {
  it("plays each message the Mac pushes, its tone first, at the Mac's speed", async () => {
    const mac = fakeMac();
    vi.stubGlobal("fetch", mac.fetch);
    const { listener, posted } = setUp();
    listener.start();
    expect(listener.store.getState().phase).toBe("starting");
    await vi.waitFor(() => expect(listener.store.getState().phase).toBe("listening"));
    mac.send(frameBytes({ message: 7, index: 0, tone: "attention" }, [0.1, 0.2]));
    mac.send(frameBytes({ message: 7, index: 1 }, [0.3]));
    await vi.waitFor(() => expect(posted.filter((each) => each.type === "piece")).toHaveLength(3));
    const pieces = posted.filter((each) => each.type === "piece");
    // The tone is made at the speed it plays at; the words at the voice's own pace.
    expect(pieces.map((each) => each.made)).toEqual([expect.any(Number), 1, 1]);
    await vi.waitFor(() => expect(posted).toContainEqual({ type: "speed", value: 1.25 }));
    listener.stop();
  });

  it("drops a message the Mac stopped, and what comes of it after", async () => {
    const mac = fakeMac();
    vi.stubGlobal("fetch", mac.fetch);
    const { listener, posted } = setUp();
    listener.start();
    await vi.waitFor(() => expect(listener.store.getState().phase).toBe("listening"));
    mac.send(frameBytes({ message: 2, index: 0 }, [0.1]));
    mac.send(frameBytes({ stop: 2 }));
    mac.send(frameBytes({ message: 2, index: 1 }, [0.2]));
    mac.send(frameBytes({ message: 3, index: 0 }, [0.3]));
    await vi.waitFor(() => expect(posted.filter((each) => each.message === 3)).toHaveLength(1));
    expect(posted.filter((each) => each.type === "drop")).toEqual([{ type: "drop", message: 2 }]);
    expect(posted.filter((each) => each.type === "piece" && each.message === 2)).toHaveLength(1);
    listener.stop();
  });

  it("asks to resume after a reload, and forgets once stopped", () => {
    vi.stubGlobal("fetch", fakeMac().fetch);
    const storage = memoryStorage();
    const first = setUp(storage);
    first.listener.start();
    // The page going away: what was playing ends, and that it was listening is kept.
    first.listener.end();
    expect(first.context.close).toHaveBeenCalled();
    const reloaded = setUp(storage);
    expect(reloaded.listener.store.getState().phase).toBe("resume");
    reloaded.listener.stop();
    expect(setUp(storage).listener.store.getState().phase).toBe("off");
  });
});

describe("reading the speech process's push stream", () => {
  it("hands out whole frames however the network splits them", () => {
    const frames: RadioFrame[] = [];
    const feed = createFrameReader((frame) => frames.push(frame));
    const both = new Uint8Array([
      ...frameBytes({ message: 3, index: 0, tone: "done" }, [0.5, -0.5]),
      ...frameBytes({}),
      ...frameBytes({ stop: 3 }),
    ]);
    // A byte at a time, the worst a network can do.
    for (const byte of both) feed(new Uint8Array([byte]));
    expect(frames.map((frame) => frame.header)).toEqual([{ message: 3, index: 0, tone: "done" }, {}, { stop: 3 }]);
    expect(Array.from(frames[0]?.samples ?? [])).toEqual([0.5, -0.5]);
    expect(frames[1]?.samples.length).toBe(0);
  });
});
