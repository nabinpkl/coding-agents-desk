import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@/lib/api", () => ({
  createReferenceSpeechArtifact: api.create,
  referenceSpeechAudioUrl: (artifactID: string) =>
    `http://voice.test/reference-speech/artifacts/${artifactID}/audio`,
}));

vi.mock("@/lib/host-bridge", () => ({
  INTERACTION_HANDLER: "interaction",
  getHostConfig: () => ({ voiceTransport: "websocket" }),
  postToHost: vi.fn(),
}));

vi.mock("@/lib/interaction-delivery", () => ({
  subscribeInteractionDelivery: vi.fn(),
}));

import {
  referenceSpeechPlaybackSnapshot,
  resetReferenceSpeechForTesting,
  speakReference,
  stopReferenceSpeech,
} from "@/features/voice/reference-speech";
import type { ReferenceSpeechArtifact } from "@/lib/wire";

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  readonly start = vi.fn();
  readonly stop = vi.fn(() => this.onended?.());
}

class FakeAudioContext {
  readonly destination = {} as AudioDestinationNode;
  readonly resume = vi.fn().mockResolvedValue(undefined);
  readonly decodeAudioData = vi.fn().mockResolvedValue({
    length: 24_000,
    numberOfChannels: 1,
  } as AudioBuffer);
  readonly sources: FakeSource[] = [];

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeSource();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }
}

const artifact = (id: string): ReferenceSpeechArtifact => ({
  id,
  audioHash: "a".repeat(64),
  text: "cache",
  ipa: "k æ ʃ",
  durationSeconds: 0.4,
  sampleRate: 24_000,
  cacheHit: true,
  voiceIdentifier: "af_heart",
  speed: 1,
  modelIdentifier: "kokoro",
  modelHash: "b".repeat(64),
  voiceHash: "c".repeat(64),
  dictionaryIdentifier: "cmudict",
  dictionaryHash: "d".repeat(64),
  synthesisMappingHash: "e".repeat(64),
  synthesizedAt: "2026-08-08T00:00:00Z",
});

const request = (index = 0) => [
  "passage-11111111111111111111111111111111",
  1,
  { kind: "word" as const, index },
  { voiceIdentifier: "af_heart", speed: 1 },
] as const;

let context: FakeAudioContext;

beforeEach(() => {
  context = new FakeAudioContext();
  api.create.mockReset();
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        return context as unknown as AudioContext;
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))),
  );
  resetReferenceSpeechForTesting();
});

afterEach(() => {
  resetReferenceSpeechForTesting();
  vi.unstubAllGlobals();
});

test("restarts a heard word from its decoded buffer without repeat I/O", async () => {
  api.create.mockResolvedValue(artifact("a".repeat(64)));

  await speakReference(...request());
  expect(referenceSpeechPlaybackSnapshot()).toMatchObject({
    status: "playing",
    requestKey: "passage-11111111111111111111111111111111:1:word:0",
  });
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(context.decodeAudioData).toHaveBeenCalledTimes(1);

  await speakReference(...request());
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
  expect(context.sources).toHaveLength(2);
  expect(context.sources[0].stop).toHaveBeenCalledOnce();
  expect(context.sources[1].start).toHaveBeenCalledWith(0);
});

test("only the latest rapid click becomes audible", async () => {
  let resolveFirst: (value: ReferenceSpeechArtifact) => void;
  let resolveSecond: (value: ReferenceSpeechArtifact) => void;
  api.create
    .mockImplementationOnce(
      () => new Promise<ReferenceSpeechArtifact>((resolve) => { resolveFirst = resolve; }),
    )
    .mockImplementationOnce(
      () => new Promise<ReferenceSpeechArtifact>((resolve) => { resolveSecond = resolve; }),
    );

  const first = speakReference(...request(0));
  const second = speakReference(...request(1));
  resolveFirst!(artifact("a".repeat(64)));
  await first;
  expect(context.sources).toHaveLength(0);

  resolveSecond!(artifact("b".repeat(64)));
  await second;
  expect(context.sources).toHaveLength(1);
  expect(context.sources[0].start).toHaveBeenCalledWith(0);
});

test("an explicit stop prevents a pending first click from playing", async () => {
  let resolveArtifact: (value: ReferenceSpeechArtifact) => void;
  api.create.mockImplementation(
    () => new Promise<ReferenceSpeechArtifact>((resolve) => { resolveArtifact = resolve; }),
  );

  const pending = speakReference(...request());
  stopReferenceSpeech();
  resolveArtifact!(artifact("a".repeat(64)));
  await pending;

  expect(context.sources).toHaveLength(0);
});
