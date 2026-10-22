import { describe, expect, test } from "bun:test";
import type { readAloud, speechForPage, stopReading, stopSpeechForPage } from "@/push/sessionSpeech";
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
  const response = await createSpeechRoutes({ speak })(...post(body), server);
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
    const response = await createSpeechRoutes({ halt })(request, new URL(request.url), server);
    expect(response?.status).toBe(204);
    expect(stops).toBe(1);
  });

  test("leaves every other path to the routes after it", () => {
    const request = new Request("http://localhost/api/speech/other", { method: "POST" });
    expect(createSpeechRoutes()(request, new URL(request.url), server)).toBeUndefined();
  });
});

function postTo(path: string, body: unknown): [Request, URL] {
  const request = new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) });
  return [request, new URL(request.url)];
}

describe("playing a reply on the device that asked", () => {
  test("streams the speech process's PCM back, under a ref of the page's own", async () => {
    const asked: [string, string][] = [];
    const pcm = new Float32Array([0.25, -0.5]);
    const speakHere: typeof speechForPage = (text, ref) => {
      asked.push([text, ref]);
      return Promise.resolve(new Response(pcm.buffer, { status: 200 }));
    };
    const response = await createSpeechRoutes({ speakHere })(
      ...postTo("/api/speech/here", { text: "It works.", ref: "a1-b2" }),
      server,
    );
    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-sample-rate")).toBe("24000");
    expect(Array.from(new Float32Array(await response!.arrayBuffer()))).toEqual([0.25, -0.5]);
    // Prefixed, so a page cannot name a Bot's message or the broadcast's reading.
    expect(asked).toEqual([["It works.", "page-a1-b2"]]);
  });

  test("refuses a ref that is not a plain name, and says when nothing can be said", async () => {
    const speakHere: typeof speechForPage = () => Promise.resolve(null);
    const routes = createSpeechRoutes({ speakHere });
    expect((await routes(...postTo("/api/speech/here", { text: "Hi.", ref: "../x" }), server))?.status).toBe(400);
    expect((await routes(...postTo("/api/speech/here", { text: "Hi." }), server))?.status).toBe(400);
    expect((await routes(...postTo("/api/speech/here", { text: "```", ref: "r" }), server))?.status).toBe(422);
  });

  test("says the speech process failed rather than streaming its error", async () => {
    const speakHere: typeof speechForPage = () => Promise.resolve(new Response("no", { status: 500 }));
    const response = await createSpeechRoutes({ speakHere })(
      ...postTo("/api/speech/here", { text: "Hi.", ref: "r" }),
      server,
    );
    expect(response?.status).toBe(502);
  });

  test("stops that page's speech by its ref", async () => {
    const stopped: string[] = [];
    const haltHere: typeof stopSpeechForPage = (ref) => {
      stopped.push(ref);
      return Promise.resolve();
    };
    const response = await createSpeechRoutes({ haltHere })(...postTo("/api/speech/here/stop", { ref: "r" }), server);
    expect(response?.status).toBe(204);
    expect(stopped).toEqual(["page-r"]);
  });
});
