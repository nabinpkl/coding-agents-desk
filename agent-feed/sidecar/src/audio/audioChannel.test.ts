import { describe, expect, test } from "bun:test";
import { AUDIO_LISTENERS_ROUTE, AUDIO_SPEAK_MAX_CHARS, AUDIO_SPEAK_ROUTE } from "@agentdesk/agent-feed-wire";
import type { AdtsFrame } from "@/audio/adtsFrames";
import { createAudioChannel, createAudioSpeakRoute, speakableText } from "@/audio/audioChannel";

/** Two ADTS frames (22050 Hz, 1024 samples each), standing in for whatever `say` would have said. */
const SPOKEN = new Uint8Array([0, 1].flatMap(() => [0xff, 0xf1, 0x5c, 0x40, 0x01, 0x7f, 0xfc, 0, 0, 0, 0]));

function fakeSpeech() {
  const said: string[] = [];
  const speak = (text: string) => {
    said.push(text);
    return Promise.resolve(SPOKEN);
  };
  return { said, speak };
}

describe("the audio channel", () => {
  test("speaks a message once and hands it to every stream listening", async () => {
    const speech = fakeSpeech();
    const channel = createAudioChannel(speech.speak);
    const inboxes: AdtsFrame[][][] = [[], []];
    const leave = inboxes.map((inbox) => channel.listen((frames) => inbox.push(frames)));

    expect(await channel.say("Build finished.")).toEqual({ listeners: 2, durationMs: 93 });
    expect(speech.said).toEqual(["Build finished."]);
    expect(inboxes.map((inbox) => inbox.map((message) => message.length))).toEqual([[2], [2]]);

    leave[0]?.();
    expect((await channel.say("Second.")).listeners).toBe(1);
    expect(inboxes.map((inbox) => inbox.length)).toEqual([1, 2]);
  });

  test("with nobody listening it says so and speaks nothing", async () => {
    const speech = fakeSpeech();
    expect(await createAudioChannel(speech.speak).say("Anyone?")).toEqual({ listeners: 0, durationMs: 0 });
    expect(speech.said).toEqual([]);
  });

  test("an agent's text cannot carry say's own [[commands]]", () => {
    expect(speakableText("[[volm 0.1]] quiet\n\n  now [[rate 400]]")).toBe("volm 0.1 quiet now rate 400");
  });
});

test("GET /api/audio/listeners counts the streams open now", async () => {
  const channel = createAudioChannel(fakeSpeech().speak);
  const route = createAudioSpeakRoute(channel);
  const count = async () => {
    const request = new Request(`http://127.0.0.1${AUDIO_LISTENERS_ROUTE}`);
    return (await route(request, new URL(request.url), undefined as never))?.json();
  };
  expect(await count()).toEqual({ listeners: 0 });
  const leave = channel.listen(() => {});
  expect(await count()).toEqual({ listeners: 1 });
  leave();
  expect(await count()).toEqual({ listeners: 0 });
});

describe("POST /api/audio/speak", () => {
  const post = (body: unknown) => {
    const speech = fakeSpeech();
    const channel = createAudioChannel(speech.speak);
    channel.listen(() => {});
    const route = createAudioSpeakRoute(channel);
    const request = new Request(`http://127.0.0.1${AUDIO_SPEAK_ROUTE}`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return Promise.resolve(route(request, new URL(request.url), undefined as never));
  };

  test("refuses with nobody listening, and says nothing", async () => {
    const speech = fakeSpeech();
    const route = createAudioSpeakRoute(createAudioChannel(speech.speak));
    const request = new Request(`http://127.0.0.1${AUDIO_SPEAK_ROUTE}`, {
      method: "POST",
      body: JSON.stringify({ text: "Hello?" }),
    });
    const response = await route(request, new URL(request.url), undefined as never);
    expect(response?.status).toBe(409);
    expect(speech.said).toEqual([]);
  });

  test("answers how many streams it reached", async () => {
    const response = await post({ text: "Tests are green." });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ listeners: 1, durationMs: 93 });
  });

  test("refuses a message with nothing to say, or too much, rather than cutting it", async () => {
    expect((await post("not json"))?.status).toBe(400);
    expect((await post({ text: " [[ ]] " }))?.status).toBe(400);
    expect((await post({ words: "hi" }))?.status).toBe(400);
    expect((await post({ text: "a".repeat(AUDIO_SPEAK_MAX_CHARS + 1) }))?.status).toBe(413);
  });
});
