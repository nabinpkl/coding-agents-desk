import { expect, test } from "bun:test";
import { createTmuxRoutes } from "@/http/tmuxRoutes";
import { TmuxUnavailable } from "@/terminal/tmux/tmuxSessions";

const server = { timeout() {} } as never;

function call(route: ReturnType<typeof createTmuxRoutes>, method: string, path: string) {
  const url = new URL(`http://127.0.0.1${path}`);
  return route(new Request(url.toString(), { method }), url, server);
}

/** The same call with a JSONable body, or a raw string to send something that is not JSON. */
function callBody(
  route: ReturnType<typeof createTmuxRoutes>,
  method: string,
  path: string,
  body: unknown,
) {
  const url = new URL(`http://127.0.0.1${path}`);
  return route(
    new Request(url.toString(), {
      method,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    url,
    server,
  );
}

// A 1x1 PNG: the sniff reads magic, never pixels, so the smallest real file is the fixture.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("reports the sessions a grid could attach to", async () => {
  const route = createTmuxRoutes(async () => [
    { name: "canvas-fork", windows: 1, attachedClients: 0, path: "/projects/agent-desk", windowList: [] },
  ]);
  const response = await call(route, "GET", "/api/tmux/sessions");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    sessions: [{ name: "canvas-fork", windows: 1, attachedClients: 0, path: "/projects/agent-desk", windowList: [] }],
  });
});

test("a machine without tmux is retryable, because installing it changes the answer", async () => {
  const route = createTmuxRoutes(async () => {
    throw new TmuxUnavailable("no tmux binary found; set AGENT_FEED_TMUX_PATH to an absolute path");
  });
  const response = await call(route, "GET", "/api/tmux/sessions");
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    error: {
      code: "tmux-unavailable",
      message: "no tmux binary found; set AGENT_FEED_TMUX_PATH to an absolute path",
      retryable: true,
    },
  });
});

test("leaves every other path alone", async () => {
  const route = createTmuxRoutes(async () => []);
  expect(await call(route, "POST", "/api/tmux/sessions")).toBeUndefined();
  expect(await call(route, "GET", "/api/tmux")).toBeUndefined();
  expect(await call(route, "DELETE", "/api/tmux")).toBeUndefined();
  expect(await call(route, "DELETE", "/api/tmux/sessions/")).toBeUndefined();
  expect(await call(route, "GET", "/api/tmux/sessions/canvas-fork")).toBeUndefined();
});

test("ends the session the owner asked to end, and nothing else", async () => {
  const killed: string[] = [];
  const route = createTmuxRoutes(async () => [], async (session) => { killed.push(session); });
  const response = await call(route, "DELETE", "/api/tmux/sessions/canvas-fork");
  expect(response?.status).toBe(204);
  expect(killed).toEqual(["canvas-fork"]);
});

test("a session that is already gone is still a 204", async () => {
  // Retiring something that has already stopped is the ordinary case: the kill resolves
  // because there was nothing to end, not because something went wrong.
  const route = createTmuxRoutes(async () => [], async () => {});
  const response = await call(route, "DELETE", "/api/tmux/sessions/canvas-fork");
  expect(response?.status).toBe(204);
});

test("refuses a kill for a name that is not a plain identifier", async () => {
  const killed: string[] = [];
  const route = createTmuxRoutes(async () => [], async (session) => { killed.push(session); });
  // The name reaches tmux as `-t =<session>`, so anything but an identifier is refused at the
  // door rather than quoted and hoped for. `%2e%2e%2f` decodes to a traversal; `%20` to a space.
  for (const name of ["a%20b", "one%3Brm", "%2e%2e%2fescape", "$(whoami)"]) {
    const response = await call(route, "DELETE", `/api/tmux/sessions/${name}`);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: {
        code: "invalid-tmux-session",
        message: "tmux session name is not a plain identifier",
        retryable: false,
      },
    });
  }
  expect(killed).toEqual([]);
});

test("a drop tmux cannot perform is retryable, because starting it changes the answer", async () => {
  const route = createTmuxRoutes(async () => [], async () => {
    throw new TmuxUnavailable("no tmux server running");
  });
  const response = await call(route, "DELETE", "/api/tmux/sessions/canvas-fork");
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    error: {
      code: "tmux-unavailable",
      message: "no tmux server running",
      retryable: true,
    },
  });
});

test("drops an image onto the named session and answers the act, not a state", async () => {
  const dropped: { session: string; mediaType: string; bytes: number }[] = [];
  const route = createTmuxRoutes(
    async () => [],
    async () => {},
    async (session, image, mediaType) => {
      dropped.push({ session, mediaType, bytes: image.length });
    },
  );
  const response = await callBody(route, "POST", "/api/tmux/sessions/canvas-fork/image", {
    data: PNG_BASE64,
  });
  expect(response?.status).toBe(204);
  expect(dropped.length).toBe(1);
  expect(dropped[0]?.session).toBe("canvas-fork");
  expect(dropped[0]?.mediaType).toBe("image/png");
  expect(dropped[0]?.bytes).toBeGreaterThan(0);
});

test("an image aimed anywhere but a plain identifier never reaches tmux", async () => {
  const dropped: string[] = [];
  const route = createTmuxRoutes(
    async () => [],
    async () => {},
    async (session) => { dropped.push(session); },
  );
  for (const name of ["a%20b", "one%3Brm", "%2e%2e%2fescape"]) {
    const response = await callBody(route, "POST", `/api/tmux/sessions/${name}/image`, {
      data: PNG_BASE64,
    });
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: {
        code: "invalid-tmux-session",
        message: "tmux session name is not a plain identifier",
        retryable: false,
      },
    });
  }
  expect(dropped).toEqual([]);
});

test("an image drop says what is wrong with its body", async () => {
  const dropped: string[] = [];
  const route = createTmuxRoutes(
    async () => [],
    async () => {},
    async (session) => { dropped.push(session); },
  );
  const bad = await callBody(route, "POST", "/api/tmux/sessions/canvas-fork/image", "not json");
  expect(bad?.status).toBe(400);
  expect(((await bad?.json()) as { error: { code: string } }).error.code).toBe("invalid-body");

  const missing = await callBody(route, "POST", "/api/tmux/sessions/canvas-fork/image", {});
  expect(missing?.status).toBe(400);
  expect(((await missing?.json()) as { error: { code: string } }).error.code).toBe("image-required");

  const encoding = await callBody(route, "POST", "/api/tmux/sessions/canvas-fork/image", {
    data: "!!!",
  });
  expect(encoding?.status).toBe(400);
  expect(((await encoding?.json()) as { error: { code: string } }).error.code).toBe("image-not-base64");

  // Text decodes and sniffs cleanly as not-an-image, which is a 415 rather than a 400: the
  // request was well formed and the content is what no pane takes.
  const text = await callBody(route, "POST", "/api/tmux/sessions/canvas-fork/image", {
    data: Buffer.from("hello").toString("base64"),
  });
  expect(text?.status).toBe(415);
  expect(await text?.json()).toEqual({
    error: {
      code: "image-unsupported",
      message: "a terminal pane takes png, jpeg, gif and webp",
      retryable: false,
    },
  });
  expect(dropped).toEqual([]);
});

test("an image larger than a pane will take is refused before it is sniffed", async () => {
  const dropped: string[] = [];
  const route = createTmuxRoutes(
    async () => [],
    async () => {},
    async (session) => { dropped.push(session); },
  );
  const big = await callBody(route, "POST", "/api/tmux/sessions/canvas-fork/image", {
    data: Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64"),
  });
  expect(big?.status).toBe(413);
  expect(((await big?.json()) as { error: { code: string } }).error.code).toBe("image-too-large");
  expect(dropped).toEqual([]);
});

test("a paste tmux cannot perform is retryable, because starting it changes the answer", async () => {
  const route = createTmuxRoutes(
    async () => [],
    async () => {},
    async () => {
      throw new TmuxUnavailable("no tmux server running");
    },
  );
  const response = await callBody(route, "POST", "/api/tmux/sessions/canvas-fork/image", {
    data: PNG_BASE64,
  });
  expect(response?.status).toBe(503);
  expect(await response?.json()).toEqual({
    error: {
      code: "tmux-unavailable",
      message: "no tmux server running",
      retryable: true,
    },
  });
});

test("leaves neighbouring POST paths alone", async () => {
  const route = createTmuxRoutes(async () => [], async () => {}, async () => {});
  expect(await call(route, "POST", "/api/tmux/sessions")).toBeUndefined();
  expect(await call(route, "POST", "/api/tmux/sessions/canvas-fork")).toBeUndefined();
});
