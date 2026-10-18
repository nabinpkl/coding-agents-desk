import { afterEach, describe, expect, test } from "bun:test";
import type { BotSnapshot } from "@agentdesk/agent-feed-wire";
import { publishedBots, startHubBotPublisher } from "@/messaging/hubBotPublisher";
import { HubClient } from "@/messaging/hubClient";
import { createHubRoutes } from "@/messaging/hubRoutes";

let fake: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => fake?.stop(true));

function fakeHub(handler: (request: Request, url: URL) => Response | Promise<Response>): HubClient {
  fake = Bun.serve({ port: 0, fetch: (request) => handler(request, new URL(request.url)) });
  return new HubClient({
    url: `http://127.0.0.1:${fake.port}`,
    machine: "mac",
    clientId: "cid",
    clientSecret: "secret",
  });
}

const call = (routes: ReturnType<typeof createHubRoutes>, method: string, path: string, body?: unknown) =>
  routes(
    new Request(`http://sidecar${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
    new URL(`http://sidecar${path}`),
    undefined as never,
  );

describe("hub routes", () => {
  test("say plainly when the hub is not configured", async () => {
    const routes = createHubRoutes(() => "hub not configured: file missing");
    const status = await call(routes, "GET", "/api/hub/status");
    expect(await status!.json()).toEqual({
      configured: false,
      machine: null,
      reason: "hub not configured: file missing",
    });
    expect((await call(routes, "GET", "/api/hub/directory"))!.status).toBe(503);
    expect(call(routes, "GET", "/api/bots")).toBeUndefined();
  });

  test("send as human, carry hub refusals through with their status", async () => {
    const seen: unknown[] = [];
    const hub = fakeHub(async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      seen.push(body);
      if (body.to === "claude:nobody") return Response.json({ error: "no such address" }, { status: 404 });
      return Response.json({ id: "m1" }, { status: 201 });
    });
    const routes = createHubRoutes(() => hub);
    const sent = await call(routes, "POST", "/api/hub/messages", {
      to: "bot:fixer",
      kind: "request",
      body: "hi",
      as: "claude:spoof",
    });
    expect(sent!.status).toBe(201);
    expect(seen[0]).toEqual({ as: "human", to: "bot:fixer", kind: "request", body: "hi" });
    await call(routes, "POST", "/api/hub/messages", { inReplyTo: "m0", body: "yes" });
    expect(seen[1]).toEqual({ as: "human", inReplyTo: "m0", body: "yes" });
    const refused = await call(routes, "POST", "/api/hub/messages", {
      to: "claude:nobody",
      kind: "request",
      body: "x",
    });
    expect(refused!.status).toBe(404);
    expect(((await refused!.json()) as { error: { message: string } }).error.message).toBe("no such address");
  });
});

describe("hub bot publisher", () => {
  const snapshot = {
    version: 2,
    revision: 3,
    bots: [
      {
        botId: "fixer",
        name: "Site fixer",
        environment: { kind: "directory", path: "/work/site" },
        sessionRefs: [
          { source: "claude", sessionId: "s1" },
          { source: "opencode", sessionId: "o1" },
        ],
      },
    ],
  } as unknown as BotSnapshot;

  test("publishes both runtimes' sessions under their source prefix, whole, under this machine", async () => {
    expect(publishedBots(snapshot)).toEqual([
      { botId: "fixer", name: "Site fixer", path: "/work/site", sessionIds: ["claude:s1", "opencode:o1"] },
    ]);
    const puts: { path: string; body: unknown }[] = [];
    const hub = fakeHub(async (request, url) => {
      puts.push({ path: url.pathname, body: await request.json() });
      return Response.json({ ok: true });
    });
    const stop = await startHubBotPublisher(
      {
        snapshot: async () => snapshot,
        subscribe: async (listener) => {
          listener(snapshot);
          return () => {};
        },
      },
      hub,
      () => {},
    );
    for (let i = 0; i < 50 && puts.length === 0; i++) await Bun.sleep(10);
    stop();
    expect(puts[0]).toEqual({ path: "/v1/directory/bots/mac", body: { bots: publishedBots(snapshot) } });
  });
});
