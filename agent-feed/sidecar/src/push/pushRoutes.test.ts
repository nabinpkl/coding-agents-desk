import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushOutcome, PushPayload, PushSubscriptionKeys } from "@/push/pushSender";
import { PUSH_KEY_ROUTE, PUSH_SUBSCRIPTIONS_ROUTE, PUSH_TEST_ROUTE } from "@agentdesk/agent-feed-wire";
import { createPushRoutes, isPushServiceEndpoint, type PushRouteOptions } from "@/push/pushRoutes";
import { readPushState } from "@/push/pushStore";

const APPLE = "https://web.push.apple.com/QGuQyavXutnMH2";
const CHROME = "https://fcm.googleapis.com/fcm/send/abc:def";
const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function harness(answer: (endpoint: string) => number = () => 201) {
  const directory = await mkdtemp(join(tmpdir(), "push-routes-"));
  directories.push(directory);
  const sent: { subscription: PushSubscriptionKeys; payload: PushPayload }[] = [];
  const options: PushRouteOptions = {
    path: join(directory, "web-push.json"),
    subject: "https://example.com",
    send: (subscription, payload): Promise<PushOutcome> => {
      sent.push({ subscription, payload });
      const status = answer(subscription.endpoint);
      return Promise.resolve({ endpoint: subscription.endpoint, status, gone: status === 404 || status === 410 });
    },
    now: () => new Date("2026-10-19T00:00:00Z"),
  };
  const routes = createPushRoutes(options);
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const url = new URL(path, "http://127.0.0.1");
    const request = new Request(url.href, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const response = routes(request, url, undefined as never);
    if (!response) throw new Error(`no route for ${method} ${path}`);
    return response;
  };
  return { options, sent, call };
}

describe("isPushServiceEndpoint", () => {
  test("accepts the browsers' push services over https and nothing else", () => {
    expect(isPushServiceEndpoint(APPLE)).toBe(true);
    expect(isPushServiceEndpoint(CHROME)).toBe(true);
    expect(isPushServiceEndpoint("http://web.push.apple.com/x")).toBe(false);
    expect(isPushServiceEndpoint("https://127.0.0.1:7682/api/config")).toBe(false);
    expect(isPushServiceEndpoint("https://evilpush.apple.com.example.org/x")).toBe(false);
    expect(isPushServiceEndpoint("not a url")).toBe(false);
  });
});

describe("push routes", () => {
  test("makes one key pair on first ask, keeps it, and writes the file 0600", async () => {
    const { options, call } = await harness();
    const first = (await (await call("GET", PUSH_KEY_ROUTE)).json()) as { publicKey: string };
    const second = (await (await call("GET", PUSH_KEY_ROUTE)).json()) as { publicKey: string };
    expect(first.publicKey.length).toBeGreaterThan(80);
    expect(second.publicKey).toBe(first.publicKey);
    expect((await stat(options.path)).mode & 0o777).toBe(0o600);
  });

  test("stores a subscription once per endpoint and refuses one aimed anywhere else", async () => {
    const { options, call } = await harness();
    await call("GET", PUSH_KEY_ROUTE);
    expect((await call("POST", PUSH_SUBSCRIPTIONS_ROUTE, { endpoint: APPLE, keys: KEYS })).status).toBe(204);
    expect((await call("POST", PUSH_SUBSCRIPTIONS_ROUTE, { endpoint: APPLE, keys: KEYS })).status).toBe(204);
    const refused = await call("POST", PUSH_SUBSCRIPTIONS_ROUTE, { endpoint: "https://127.0.0.1/x", keys: KEYS });
    expect(refused.status).toBe(400);
    expect((await call("POST", PUSH_SUBSCRIPTIONS_ROUTE, { endpoint: CHROME })).status).toBe(400);
    expect((await readPushState(options.path))?.subscriptions.map((entry) => entry.endpoint)).toEqual([APPLE]);
  });

  test("a subscription posted again on a later load keeps the time it was first stored", async () => {
    let now = new Date("2026-10-19T00:00:00Z");
    const { options, call } = await harness();
    options.now = () => now;
    const routes = createPushRoutes(options);
    const post = (body: unknown) => {
      const url = new URL(PUSH_SUBSCRIPTIONS_ROUTE, "http://127.0.0.1");
      return routes(new Request(url.href, { method: "POST", body: JSON.stringify(body) }), url, undefined as never);
    };
    await call("GET", PUSH_KEY_ROUTE);
    await post({ endpoint: APPLE, keys: KEYS });
    now = new Date("2026-10-20T00:00:00Z");
    await post({ endpoint: APPLE, keys: { ...KEYS, auth: "rotatedAuthSecret00000" } });
    const stored = (await readPushState(options.path))?.subscriptions ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.addedAt).toBe("2026-10-19T00:00:00.000Z");
    expect(stored[0]?.keys.auth).toBe("rotatedAuthSecret00000");
  });

  test("a device whose push service cannot be reached does not cost the others their send", async () => {
    const { options, call } = await harness();
    options.send = (subscription) =>
      subscription.endpoint === CHROME
        ? Promise.reject(new Error("socket timeout"))
        : Promise.resolve({ endpoint: subscription.endpoint, status: 201, gone: false });
    const routes = createPushRoutes(options);
    await call("GET", PUSH_KEY_ROUTE);
    await call("POST", PUSH_SUBSCRIPTIONS_ROUTE, { endpoint: APPLE, keys: KEYS });
    await call("POST", PUSH_SUBSCRIPTIONS_ROUTE, { endpoint: CHROME, keys: KEYS });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const url = new URL(PUSH_TEST_ROUTE, "http://127.0.0.1");
    const response = await routes(new Request(url.href, { method: "POST" }), url, undefined as never);
    warn.mockRestore();
    expect(await response?.json()).toEqual({
      sent: [
        { host: "web.push.apple.com", status: 201, gone: false },
        { host: "fcm.googleapis.com", status: 0, gone: false },
      ],
    });
    expect((await readPushState(options.path))?.subscriptions).toHaveLength(2);
  });

  test("a test push goes to every subscription and forgets the ones the service calls gone", async () => {
    const { options, sent, call } = await harness((endpoint) => (endpoint === CHROME ? 410 : 201));
    expect((await call("POST", PUSH_TEST_ROUTE)).status).toBe(409);
    await call("GET", PUSH_KEY_ROUTE);
    await call("POST", PUSH_SUBSCRIPTIONS_ROUTE, { endpoint: APPLE, keys: KEYS });
    await call("POST", PUSH_SUBSCRIPTIONS_ROUTE, { endpoint: CHROME, keys: KEYS });

    const response = await call("POST", PUSH_TEST_ROUTE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sent: [
        { host: "web.push.apple.com", status: 201, gone: false },
        { host: "fcm.googleapis.com", status: 410, gone: true },
      ],
    });
    expect(sent.map((entry) => entry.payload.tag)).toEqual(["push-test", "push-test"]);
    expect((await readPushState(options.path))?.subscriptions.map((entry) => entry.endpoint)).toEqual([APPLE]);
  });
});
