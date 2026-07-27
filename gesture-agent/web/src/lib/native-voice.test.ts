import { afterAll, beforeAll, expect, test } from "vitest";

import { listRecordings } from "@/lib/api";
import {
  speakReference,
  stopReferenceSpeech,
} from "@/features/voice/reference-speech";
import {
  browserSpeechRate,
  parseReferenceSpeechState,
  postReferenceSpeechPreferencesUpdate,
  requestReferenceSpeechState,
} from "@/features/voice/reference-speech-settings";
import { VoiceSocket } from "@/lib/ws";
import type { RecordingListResponse } from "@/lib/wire";

type TestWindow = typeof globalThis & {
  __interactionConfig?: { voiceTransport: "native" };
  __interactionDeliver?: (delivery: unknown) => void;
  webkit?: {
    messageHandlers: {
      interaction: { postMessage(message: unknown): void };
    };
  };
};

const testWindow = globalThis as TestWindow;
const posted: Array<Record<string, unknown>> = [];

beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    configurable: true,
  });
  testWindow.__interactionConfig = { voiceTransport: "native" };
  testWindow.webkit = {
    messageHandlers: {
      interaction: {
        postMessage(message) {
          posted.push(message as Record<string, unknown>);
        },
      },
    },
  };
});

afterAll(() => {
  delete (globalThis as { window?: unknown }).window;
  delete testWindow.__interactionConfig;
  delete testWindow.__interactionDeliver;
  delete testWindow.webkit;
});

function deliver(payload: Record<string, unknown>): void {
  testWindow.__interactionDeliver?.({ type: "voiceLane", payload });
}

test("reference speech uses the local native bridge", () => {
  posted.length = 0;
  speakReference("  Hello, hello.  ");
  expect(posted.at(-1)).toEqual({
    t: "referenceSpeech",
    text: "Hello, hello.",
    language: "en-US",
  });

  stopReferenceSpeech();
  expect(posted.at(-1)).toEqual({ t: "referenceSpeechStop" });
});

test("reference speech rejects oversized text before crossing native", () => {
  posted.length = 0;
  expect(() => speakReference("a".repeat(20_001))).toThrow(
    "Reference speech is too long.",
  );
  expect(posted).toEqual([]);
});

test("reference speech preferences use the local native bridge", () => {
  posted.length = 0;
  requestReferenceSpeechState();
  expect(posted.at(-1)).toEqual({
    t: "referenceSpeechStateRequest",
  });

  postReferenceSpeechPreferencesUpdate("voice-1", 0.65);
  expect(posted.at(-1)).toEqual({
    t: "referenceSpeechPreferencesUpdate",
    voiceIdentifier: "voice-1",
    rate: 0.65,
  });

  postReferenceSpeechPreferencesUpdate(null, 0.5);
  expect(posted.at(-1)).toEqual({
    t: "referenceSpeechPreferencesUpdate",
    voiceIdentifier: null,
    rate: 0.5,
  });
  expect(() =>
    postReferenceSpeechPreferencesUpdate("voice-1", Number.NaN),
  ).toThrow("Reference speech preferences are invalid.");
});

test("reference speech state validates native inventory and rates", () => {
  const state = parseReferenceSpeechState({
    language: "en-US",
    voices: [
      {
        identifier: "voice-1",
        name: "Samantha",
        language: "en-US",
        quality: "premium",
      },
    ],
    selectedVoiceIdentifier: "voice-1",
    rate: {
      minimum: 0,
      defaultValue: 0.5,
      maximum: 1,
      current: 0.65,
    },
  });
  expect(state?.voices[0]?.name).toBe("Samantha");
  expect(state?.rate.current).toBe(0.65);
  expect(
    parseReferenceSpeechState({
      language: "en-US",
      voices: [],
      rate: {
        minimum: 0,
        defaultValue: 0.5,
        maximum: 1,
        current: Number.NaN,
      },
    }),
  ).toBeNull();
  expect(browserSpeechRate(0.5)).toBe(1);
  expect(browserSpeechRate(0)).toBe(0.1);
});

test("native REST reassembles bounded response chunks", async () => {
  posted.length = 0;
  const pending = listRecordings();
  const request = posted.at(-1);
  expect(request?.t).toBe("voiceREST");
  const requestID = request?.requestID as string;
  const response: RecordingListResponse = {
    recordings: [
      {
        id: "session-20260726-221100-123456",
        createdAt: "2026-07-26T22:11:00Z",
        durationSeconds: 4.2,
        source: "iphone",
        status: "completed",
        observedPhones: ["θ", "æ", "ŋ", "k"],
        wordPhoneGroups: [
          {
            word: "thank",
            heardPhones: ["θ", "æ", "ŋ", "k"],
            referencePhones: ["θ", "æ", "ŋ", "k"],
            hasReferencePronunciation: true,
          },
        ],
        unknownReferenceWords: [],
        sampleRate: 16_000,
      },
    ],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(response));
  const split = Math.floor(bytes.length / 2);
  for (const [sequence, chunk] of [
    bytes.slice(0, split),
    bytes.slice(split),
  ].entries()) {
    deliver({
      t: "rest",
      r: {
        requestID,
        status: 200,
        contentType: "application/json",
        sequence,
        isFinal: sequence === 1,
        body: Buffer.from(chunk).toString("base64"),
      },
    });
  }
  await expect(pending).resolves.toEqual(response.recordings);
});

test("native socket uses the shared browser wire messages", async () => {
  posted.length = 0;
  const socket = new VoiceSocket();
  const connected = socket.connect();
  const open = posted.at(-1);
  expect(open?.t).toBe("voiceSocketOpen");
  deliver({
    t: "socketOpened",
    rid: open?.requestID,
    sid: open?.recordingSessionID,
  });
  await connected;

  socket.sendControl({ type: "sessionStop" });
  expect(posted.at(-1)).toMatchObject({
    t: "voiceSocketMessage",
    recordingSessionID: open?.recordingSessionID,
    json: JSON.stringify({ type: "sessionStop" }),
  });
  socket.close();
  expect(posted.at(-1)).toMatchObject({
    t: "voiceSocketClose",
    recordingSessionID: open?.recordingSessionID,
  });
});

test("REST errors do not close an unrelated active socket", async () => {
  posted.length = 0;
  const socket = new VoiceSocket();
  const connected = socket.connect();
  const open = posted.at(-1);
  deliver({
    t: "socketOpened",
    rid: open?.requestID,
    sid: open?.recordingSessionID,
  });
  await connected;

  deliver({
    t: "error",
    rid: "unrelated-rest-request",
    c: "sidecarUnavailable",
    m: "list failed",
  });

  socket.sendControl({ type: "sessionStop" });
  expect(posted.at(-1)).toMatchObject({
    t: "voiceSocketMessage",
    recordingSessionID: open?.recordingSessionID,
  });
  socket.close();
});
