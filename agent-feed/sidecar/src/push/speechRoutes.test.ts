import { describe, expect, test } from "bun:test";
import type { readAloud, speechForPage, stopReading, stopSpeechForPage } from "@/push/sessionSpeech";
import { createSpeechRoutes, type SessionSay } from "@/push/speechRoutes";

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

describe("tuning how speech is processed", () => {
  const STATE = { tuning: { on: true, loudnessDb: 12 }, ranges: { loudnessDb: { min: 0, max: 24, step: 0.5 } } };

  function tuningRequest(method: "GET" | "POST", body?: unknown): [Request, URL] {
    const request = new Request("http://localhost/api/speech/tuning", {
      method,
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return [request, new URL(request.url)];
  }

  test("reads the settings, and passes a change through as it was sent", async () => {
    const asked: (Record<string, unknown> | null)[] = [];
    const tune = (changes: Record<string, unknown> | null) => {
      asked.push(changes);
      return Promise.resolve(Response.json(STATE));
    };
    const routes = createSpeechRoutes({ tune });
    const read = await routes(...tuningRequest("GET"), server);
    expect({ status: read?.status, body: await read?.json() }).toEqual({ status: 200, body: STATE });
    const changed = await routes(...tuningRequest("POST", { loudnessDb: 12 }), server);
    expect(changed?.status).toBe(200);
    expect(asked).toEqual([null, { loudnessDb: 12 }]);
  });

  test("hands back the speech process's refusal, and says when it is not answering", async () => {
    const refused = () =>
      Promise.resolve(
        Response.json({ error: { code: "invalid_tuning", message: "there is no setting 'volume'" } }, { status: 400 }),
      );
    const answer = await createSpeechRoutes({ tune: refused })(...tuningRequest("POST", { volume: 3 }), server);
    expect({ status: answer?.status, body: await answer?.json() }).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_tuning" } },
    });
    const down = () => Promise.reject(new Error("connection refused"));
    expect((await createSpeechRoutes({ tune: down })(...tuningRequest("GET"), server))?.status).toBe(502);
    expect((await createSpeechRoutes({ tune: refused })(...tuningRequest("POST", "not json"), server))?.status).toBe(
      400,
    );
  });
});

describe("a session saying something itself", () => {
  function sayRequest(body: unknown): [Request, URL] {
    const request = new Request("http://localhost/api/speech/say", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return [request, new URL(request.url)];
  }

  async function answer(sayAs: SessionSay, body: unknown) {
    const response = await createSpeechRoutes({ sayAs })(...sayRequest(body), server);
    return { status: response?.status, body: await response?.json() };
  }

  const heard: SessionSay = () =>
    Promise.resolve({ outcome: { said: true, listeners: 1, durationMs: 900 }, speaker: "Felix", voice: "Hadley" });

  test("hands over the session and its text, and says who it was said as", async () => {
    const asked: unknown[] = [];
    const sayAs: SessionSay = (ref, text) => {
      asked.push({ ref, text });
      return heard(ref, text);
    };
    expect(await answer(sayAs, { session: "opencode:ses_1", text: "Tests pass." })).toEqual({
      status: 200,
      body: { listeners: 1, durationMs: 900, speaker: "Felix", voice: "Hadley" },
    });
    expect(asked).toEqual([{ ref: { source: "opencode", sessionId: "ses_1" }, text: "Tests pass." }]);
  });

  test("says why when it was not said", async () => {
    const not =
      (why: "nobody-listening" | "replaced" | "stopped" | "failed"): SessionSay =>
      () =>
        Promise.resolve({ outcome: { said: false, why }, speaker: "Felix", voice: null });
    const body = { session: "claude:s1", text: "Hi." };
    expect(await answer(not("nobody-listening"), body)).toMatchObject({
      status: 409,
      body: { error: { code: "nobody_listening" } },
    });
    expect(await answer(not("replaced"), body)).toMatchObject({ status: 409, body: { error: { code: "replaced" } } });
    expect((await answer(not("failed"), body)).status).toBe(502);
    expect((await answer(() => Promise.resolve("unknown-session"), body)).status).toBe(404);
    expect((await answer(() => Promise.resolve(null), body)).status).toBe(422);
  });

  test("refuses a message it cannot place or that is too long, before anything is said", async () => {
    let calls = 0;
    const sayAs: SessionSay = (ref, text) => {
      calls += 1;
      return heard(ref, text);
    };
    expect((await answer(sayAs, { session: "s1", text: "Hi." })).status).toBe(400);
    expect((await answer(sayAs, { session: "claude:", text: "Hi." })).status).toBe(400);
    expect((await answer(sayAs, { session: "mail:s1", text: "Hi." })).status).toBe(400);
    expect((await answer(sayAs, { session: "claude:s1", text: "  " })).status).toBe(400);
    expect((await answer(sayAs, "not json")).status).toBe(400);
    expect((await answer(sayAs, { session: "claude:s1", text: "a".repeat(1_001) })).status).toBe(413);
    expect(calls).toBe(0);
  });
});
