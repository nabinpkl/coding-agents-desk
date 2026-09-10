import { expect, test } from "bun:test";
import { createTmuxRoutes } from "@/http/tmuxRoutes";
import { TmuxUnavailable } from "@/terminal/tmuxSessions";

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
});
