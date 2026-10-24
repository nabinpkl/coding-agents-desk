import { afterAll, describe, expect, test } from "bun:test";
import { createAudioForward } from "@/audio/audioForward";

/** A stand-in audio process that answers with what it was sent. */
const echo = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    return Response.json(
      {
        method: request.method,
        path: url.pathname + url.search,
        host: request.headers.get("host"),
        body: await request.text(),
      },
      { status: url.pathname.endsWith("/speak") ? 409 : 200 },
    );
  },
});
afterAll(() => echo.stop(true));

function portOf(server: { port?: number }): number {
  if (server.port === undefined) throw new Error("the test server has no port");
  return server.port;
}
const ECHO_PORT = portOf(echo);

const call = (port: number, path: string, init?: RequestInit) => {
  const request = new Request(`http://127.0.0.1:7682${path}`, init);
  return createAudioForward(port)(request, new URL(request.url), undefined as never);
};

describe("the sidecar's /api/audio/*", () => {
  test("is passed to the audio process as sent, addressed to it, and its answer passed back", async () => {
    const response = await call(ECHO_PORT, "/api/audio/speak?x=1", { method: "POST", body: '{"text":"hi"}' });
    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({
      method: "POST",
      path: "/api/audio/speak?x=1",
      host: `127.0.0.1:${ECHO_PORT}`,
      body: '{"text":"hi"}',
    });
  });

  test("leaves every other path to the routes after it", () => {
    expect(call(ECHO_PORT, "/api/config")).toBeUndefined();
    expect(call(ECHO_PORT, "/api/audiobook")).toBeUndefined();
  });

  test("answers 502, naming the process, when it is not there", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = portOf(closed);
    await closed.stop(true);
    const response = await call(port, "/api/audio/listeners");
    expect(response?.status).toBe(502);
    expect(JSON.stringify(await response?.json())).toContain(`127.0.0.1:${port}`);
  });
});
