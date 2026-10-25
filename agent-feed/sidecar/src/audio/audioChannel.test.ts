import { describe, expect, test } from "bun:test";
import {
  AUDIO_LISTENERS_ROUTE,
  AUDIO_NOISE_ROUTE,
  AUDIO_SPEAK_MAX_CHARS,
  AUDIO_SPEAK_ROUTE,
} from "@agentdesk/agent-feed-wire";
import type { AdtsFrame } from "@/audio/adtsFrames";
import { createAudioChannel, createAudioChannelRoutes, speakableText } from "@/audio/audioChannel";

/** One frame per level a message was mixed at, its bytes the level's loudest sample, so a test can read back which mix it got. */
function fakeSpeech() {
  const said: string[] = [];
  const mixes: number[] = [];
  return {
    said,
    mixes,
    speak: (text: string) => {
      said.push(text);
      return Promise.resolve(new Int16Array(4));
    },
    encode: (samples: Int16Array) => {
      const loudest = Math.max(...samples.map(Math.abs));
      mixes.push(loudest);
      const frame: AdtsFrame = { bytes: new Uint8Array([loudest & 0xff]), durationMs: 46.4 };
      return Promise.resolve([frame, frame]);
    },
  };
}

/** Noise at full swing, so a level's mix is told apart by its loudest sample. */
const loudest = () => 1;

describe("the audio channel", () => {
  test("speaks once, mixes once per level in use, and gives each device its own level's mix", async () => {
    const speech = fakeSpeech();
    const channel = createAudioChannel(speech, loudest);
    const heard = new Map<string, AdtsFrame[][]>([
      ["phone", []],
      ["mac", []],
    ]);
    channel.listen("phone", 5, (frames) => heard.get("phone")?.push(frames));
    channel.listen("mac", 0, (frames) => heard.get("mac")?.push(frames));

    expect(await channel.say("Build finished.")).toEqual({ listeners: 2, durationMs: 93 });
    expect(speech.said).toEqual(["Build finished."]);
    expect(speech.mixes.toSorted((a, b) => a - b)).toEqual([0, 2458]); // 0.3 * (5/10)^2 of 32767, rounded
    expect(heard.get("mac")?.[0]?.[0]?.bytes[0]).toBe(0);
    expect(heard.get("phone")?.[0]?.[0]?.bytes[0]).toBe(2458 & 0xff);
  });

  test("counts a device once however many streams it has open, and lets it go with the last", () => {
    const channel = createAudioChannel(fakeSpeech(), loudest);
    const probe = channel.listen("phone", 3, () => {});
    const playing = channel.listen("phone", 3, () => {});
    expect(channel.listening()).toBe(1);
    probe();
    expect(channel.listening()).toBe(1);
    expect(channel.level("phone")).toBe(3);
    playing();
    expect(channel.listening()).toBe(0);
    expect(channel.setLevel("phone", 4)).toBe(false);
  });

  test("with nobody listening it says so and speaks nothing", async () => {
    const speech = fakeSpeech();
    expect(await createAudioChannel(speech, loudest).say("Anyone?")).toEqual({ listeners: 0, durationMs: 0 });
    expect(speech.said).toEqual([]);
  });

  test("an agent's text cannot carry say's own [[commands]]", () => {
    expect(speakableText("[[volm 0.1]] quiet\n\n  now [[rate 400]]")).toBe("volm 0.1 quiet now rate 400");
  });
});

describe("the channel's routes", () => {
  const call = async (channel: ReturnType<typeof createAudioChannel>, path: string, body?: unknown) => {
    const route = createAudioChannelRoutes(channel);
    const request = new Request(`http://127.0.0.1${path}`, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return route(request, new URL(request.url), undefined as never);
  };

  test("speak answers how many devices it reached, and refuses with nobody listening", async () => {
    const speech = fakeSpeech();
    const channel = createAudioChannel(speech, loudest);
    expect((await call(channel, AUDIO_SPEAK_ROUTE, { text: "Hello?" }))?.status).toBe(409);
    expect(speech.said).toEqual([]);
    channel.listen("phone", 0, () => {});
    const response = await call(channel, AUDIO_SPEAK_ROUTE, { text: "Tests are green." });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ listeners: 1, durationMs: 93 });
  });

  test("speak refuses a message with nothing to say, or too much, rather than cutting it", async () => {
    const channel = createAudioChannel(fakeSpeech(), loudest);
    channel.listen("phone", 0, () => {});
    expect((await call(channel, AUDIO_SPEAK_ROUTE, "not json"))?.status).toBe(400);
    expect((await call(channel, AUDIO_SPEAK_ROUTE, { text: " [[ ]] " }))?.status).toBe(400);
    expect((await call(channel, AUDIO_SPEAK_ROUTE, { words: "hi" }))?.status).toBe(400);
    expect((await call(channel, AUDIO_SPEAK_ROUTE, { text: "a".repeat(AUDIO_SPEAK_MAX_CHARS + 1) }))?.status).toBe(413);
  });

  test("noise sets a listening device's level, and only a listening one's", async () => {
    const channel = createAudioChannel(fakeSpeech(), loudest);
    expect((await call(channel, AUDIO_NOISE_ROUTE, { listener: "phone", level: 4 }))?.status).toBe(404);
    channel.listen("phone", 2, () => {});
    expect((await call(channel, AUDIO_NOISE_ROUTE, { listener: "phone", level: 7.4 }))?.status).toBe(204);
    expect(channel.level("phone")).toBe(7);
    expect((await call(channel, AUDIO_NOISE_ROUTE, { listener: "phone", level: 99 }))?.status).toBe(204);
    expect(channel.level("phone")).toBe(10);
    expect((await call(channel, AUDIO_NOISE_ROUTE, { listener: "phone" }))?.status).toBe(400);
  });

  test("listeners counts the devices listening now", async () => {
    const channel = createAudioChannel(fakeSpeech(), loudest);
    const count = async () => (await call(channel, AUDIO_LISTENERS_ROUTE))?.json();
    expect(await count()).toEqual({ listeners: 0 });
    const leave = channel.listen("phone", 0, () => {});
    expect(await count()).toEqual({ listeners: 1 });
    leave();
    expect(await count()).toEqual({ listeners: 0 });
  });
});
