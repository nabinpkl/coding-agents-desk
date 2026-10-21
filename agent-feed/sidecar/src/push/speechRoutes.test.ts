import { describe, expect, test } from "bun:test";
import type { readAloud, stopReading } from "@/push/sessionSpeech";
import { createSpeechRoutes } from "@/push/speechRoutes";

const server = {} as never;

function post(body: unknown): [Request, URL] {
  const request = new Request("http://localhost/api/speech/read", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return [request, new URL(request.url)];
}

async function answer(speak: typeof readAloud, body: unknown) {
  const response = await createSpeechRoutes(speak)(...post(body), server);
  return { status: response?.status, body: await response?.json() };
}

describe("reading a reply out loud", () => {
  test("hands the text to the reader and says who heard it", async () => {
    const asked: string[] = [];
    const speak = (text: string) => {
      asked.push(text);
      return Promise.resolve({ said: true as const, listeners: 2, durationMs: 1500 });
    };
    expect(await answer(speak, { text: "It works." })).toEqual({
      status: 200,
      body: { listeners: 2, durationMs: 1500 },
    });
    expect(asked).toEqual(["It works."]);
  });

  test("says so when nobody is listening, or nothing could be said", async () => {
    const nobody = () => Promise.resolve({ said: false as const, why: "nobody-listening" as const });
    expect((await answer(nobody, { text: "Hi." })).status).toBe(409);
    expect((await answer(() => Promise.resolve(null), { text: "```\ncode\n```" })).status).toBe(422);
    const stopped = () => Promise.resolve({ said: false as const, why: "stopped" as const });
    expect(await answer(stopped, { text: "Long." })).toMatchObject({
      status: 409,
      body: { error: { code: "stopped" } },
    });
  });

  test("refuses a body with no text", async () => {
    const speak = () => Promise.resolve({ said: true as const, listeners: 1, durationMs: 1 });
    expect((await answer(speak, { text: "  " })).status).toBe(400);
    expect((await answer(speak, "not json")).status).toBe(400);
  });

  test("stops the reading on its own route", async () => {
    let stops = 0;
    const halt: typeof stopReading = () => {
      stops += 1;
      return Promise.resolve();
    };
    const request = new Request("http://localhost/api/speech/stop", { method: "POST" });
    const response = await createSpeechRoutes(() => Promise.resolve(null), halt)(request, new URL(request.url), server);
    expect(response?.status).toBe(204);
    expect(stops).toBe(1);
  });

  test("leaves every other path to the routes after it", () => {
    const request = new Request("http://localhost/api/speech/other", { method: "POST" });
    expect(createSpeechRoutes(() => Promise.resolve(null))(request, new URL(request.url), server)).toBeUndefined();
  });
});
