// Naming what one session is doing, at the session's own address.
//
// Moved off the Bot endpoint for the same reason forking moved: renaming a bracket is something
// done to a session, and the response naming the holding Bot is the registry's answer, not the
// route's address. The old address answers nothing now -- removed means deleted entirely.

import { expect, test } from "bun:test";
import type { BotRegistry } from "@/bots/botRegistry";
import { createBotRoutes } from "@/http/botRoutes";
import { createBracketRoutes } from "@/http/session-routes/bracketRoutes";
import { RepositoryGitWatch } from "@/workspace/repositoryWatch";

const server = { timeout() {} } as never;
const repositories = new RepositoryGitWatch({ quietMs: 50, longestWaitMs: 200 });
const LIMITS = { maxTextBytes: 64, maxDocumentBytes: 1024 };
const DEPENDENCIES = { renameSession: async () => {} };

function bracketRoute(registry: BotRegistry) {
  return createBracketRoutes(registry, DEPENDENCIES);
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("renames one session's bracket through the registry, addressed by the session", async () => {
  const calls: unknown[] = [];
  const renamed = { botId: "bot-1", anchor: "Aaron", title: "Aaron (night shift)", status: "renamed" };
  const registry = {
    async renameBracket(ref: unknown, task: unknown, renamer: unknown) {
      calls.push({ ref, task, renamer });
      return renamed;
    },
  } as unknown as BotRegistry;
  const rename = async () => {};
  const route = createBracketRoutes(registry, { renameSession: rename });
  const request = post("/api/sessions/claude/session-1/bracket", { task: "night shift" });

  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual(renamed);
  // The session crosses in the path and the task in the body; the anchor never crosses, and the
  // route hands the renamer through.
  expect(calls).toEqual([
    {
      ref: { source: "claude", sessionId: "session-1" },
      task: "night shift",
      renamer: rename,
    },
  ]);
});

test("refuses a bracket rename that names no task text", async () => {
  const registry = {
    async renameBracket() {
      throw new Error("unreached: validation is the route's");
    },
  } as unknown as BotRegistry;
  const route = bracketRoute(registry);
  const request = post("/api/sessions/claude/session-1/bracket", {});

  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(400);
});

test("refuses a bracket rename for a source the wire does not know", async () => {
  const registry = {
    async renameBracket() {
      throw new Error("unreached: validation is the route's");
    },
  } as unknown as BotRegistry;
  const route = bracketRoute(registry);
  const request = post("/api/sessions/carrier-pigeon/session-1/bracket", { task: "night shift" });

  const response = await route(request, new URL(request.url), server);

  expect(response?.status).toBe(400);
});

test("declines anything but a POST, so the next handler gets a look", async () => {
  const registry = {} as unknown as BotRegistry;
  const route = bracketRoute(registry);
  const url = new URL("http://localhost/api/sessions/claude/session-1/bracket");
  const response = await route(new Request(url.toString(), { method: "GET" }), url, server);

  expect(response).toBeUndefined();
});

test("the retired Bot address answers nothing now", async () => {
  const registry = {
    async renameBracket() {
      throw new Error("unreached: the old address is gone");
    },
  } as unknown as BotRegistry;
  const route = createBotRoutes(registry, repositories, LIMITS);
  const request = post("/api/bots/sessions/rename-bracket", {
    source: "claude",
    sessionId: "session-1",
    task: "night shift",
  });

  expect(await route(request, new URL(request.url), server)).toBeUndefined();
});
