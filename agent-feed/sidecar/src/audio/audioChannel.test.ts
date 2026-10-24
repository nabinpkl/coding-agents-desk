import { describe, expect, test } from "bun:test";
import {
  AUDIO_LISTENERS_ROUTE,
  AUDIO_NOISE_ROUTE,
  AUDIO_SPEAK_MAX_CHARS,
  AUDIO_SPEAK_ROUTE,
} from "@agentdesk/agent-feed-wire";
import { createAudioChannel, createAudioChannelRoutes, speakableText } from "@/audio/audioChannel";
import { SAMPLE_RATE } from "@/audio/pcmAudio";

/** Speech that is two seconds of nothing, recording what it was asked to say. */
function fakeSpeak() {
  const said: string[] = [];
  const speak = (text: string) => {
    said.push(text);
    return Promise.resolve(new Int16Array(2 * SAMPLE_RATE));
  };
  return { said, speak };
}

const PINK_3 = { level: 3, color: "pink" } as const;

describe("the audio channel", () => {
  test("speaks a message once and hands its samples to every stream of every device", async () => {
    const { said, speak } = fakeSpeak();
    const channel = createAudioChannel(speak);
    const heard: Int16Array[] = [];
    channel.listen("phone", PINK_3, (speech) => heard.push(speech));
    channel.listen("phone", PINK_3, (speech) => heard.push(speech));
    channel.listen("mac", { level: 0, color: "white" }, (speech) => heard.push(speech));

    expect(await channel.say("Build finished.")).toEqual({ listeners: 2, durationMs: 2000 });
    expect(said).toEqual(["Build finished."]);
    expect(heard.length).toBe(3);
    expect(new Set(heard).size).toBe(1);
  });

  test("counts a device once however many streams it has open, and lets it go with the last", () => {
    const channel = createAudioChannel(fakeSpeak().speak);
    const probe = channel.listen("phone", PINK_3, () => {});
    const playing = channel.listen("phone", PINK_3, () => {});
    expect(channel.listening()).toBe(1);
    probe();
    expect(channel.listening()).toBe(1);
    expect(channel.noise("phone")).toEqual(PINK_3);
    playing();
    expect(channel.listening()).toBe(0);
    expect(channel.setNoise("phone", { level: 4 })).toBe(false);
  });

  test("changes a device's level and color apart, and keeps levels to whole steps from 0 to 10", () => {
    const channel = createAudioChannel(fakeSpeak().speak);
    channel.listen("phone", PINK_3, () => {});
    channel.setNoise("phone", { color: "brown" });
    expect(channel.noise("phone")).toEqual({ level: 3, color: "brown" });
    channel.setNoise("phone", { level: 7.4 });
    expect(channel.noise("phone")).toEqual({ level: 7, color: "brown" });
    channel.setNoise("phone", { level: 99 });
    expect(channel.noise("phone").level).toBe(10);
  });

  test("with nobody listening it says so and speaks nothing", async () => {
    const { said, speak } = fakeSpeak();
    expect(await createAudioChannel(speak).say("Anyone?")).toEqual({ listeners: 0, durationMs: 0 });
    expect(said).toEqual([]);
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
    const { said, speak } = fakeSpeak();
    const channel = createAudioChannel(speak);
    expect((await call(channel, AUDIO_SPEAK_ROUTE, { text: "Hello?" }))?.status).toBe(409);
    expect(said).toEqual([]);
    channel.listen("phone", PINK_3, () => {});
    const response = await call(channel, AUDIO_SPEAK_ROUTE, { text: "Tests are green." });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ listeners: 1, durationMs: 2000 });
  });

  test("speak refuses a message with nothing to say, or too much, rather than cutting it", async () => {
    const channel = createAudioChannel(fakeSpeak().speak);
    channel.listen("phone", PINK_3, () => {});
    expect((await call(channel, AUDIO_SPEAK_ROUTE, "not json"))?.status).toBe(400);
    expect((await call(channel, AUDIO_SPEAK_ROUTE, { text: " [[ ]] " }))?.status).toBe(400);
    expect((await call(channel, AUDIO_SPEAK_ROUTE, { words: "hi" }))?.status).toBe(400);
    expect((await call(channel, AUDIO_SPEAK_ROUTE, { text: "a".repeat(AUDIO_SPEAK_MAX_CHARS + 1) }))?.status).toBe(413);
  });

  test("noise changes a listening device's level or color, and only a listening one's", async () => {
    const channel = createAudioChannel(fakeSpeak().speak);
    expect((await call(channel, AUDIO_NOISE_ROUTE, { listener: "phone", level: 4 }))?.status).toBe(404);
    channel.listen("phone", PINK_3, () => {});
    expect((await call(channel, AUDIO_NOISE_ROUTE, { listener: "phone", color: "brown", level: 5 }))?.status).toBe(204);
    expect(channel.noise("phone")).toEqual({ level: 5, color: "brown" });
    expect((await call(channel, AUDIO_NOISE_ROUTE, { listener: "phone", color: "blue" }))?.status).toBe(400);
    expect((await call(channel, AUDIO_NOISE_ROUTE, { listener: "phone" }))?.status).toBe(400);
    expect(channel.noise("phone")).toEqual({ level: 5, color: "brown" });
  });

  test("listeners counts the devices listening now", async () => {
    const channel = createAudioChannel(fakeSpeak().speak);
    const count = async () => (await call(channel, AUDIO_LISTENERS_ROUTE))?.json();
    expect(await count()).toEqual({ listeners: 0 });
    const leave = channel.listen("phone", PINK_3, () => {});
    expect(await count()).toEqual({ listeners: 1 });
    leave();
    expect(await count()).toEqual({ listeners: 0 });
  });
});
