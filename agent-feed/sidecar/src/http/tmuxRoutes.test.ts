import { expect, test } from "bun:test";
import { createTmuxRoutes } from "@/http/tmuxRoutes";
import { TmuxUnavailable } from "@/terminal/tmux/tmuxSessions";

const server = { timeout() {} } as never;

function call(route: ReturnType<typeof createTmuxRoutes>, method: string, path: string) {
  const url = new URL(`http://127.0.0.1${path}`);
  return route(new Request(url.toString(), { method }), url, server);
}

test("reports the sessions a grid could attach to", async () => {
  const route = createTmuxRoutes(async () => [
    { name: "canvas-fork", windows: 1, attachedClients: 0, path: "/projects/agent-desk" },
  ]);
  const response = await call(route, "GET", "/api/tmux/sessions");
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    sessions: [{ name: "canvas-fork", windows: 1, attachedClients: 0, path: "/projects/agent-desk" }],
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

test("a kill tmux cannot perform is retryable, because starting it changes the answer", async () => {
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
