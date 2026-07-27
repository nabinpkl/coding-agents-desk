import { afterAll, beforeAll, expect, test } from "vitest";

import { listRecordings } from "@/lib/api";
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
