import { afterAll, expect, test } from "bun:test";
import { refuseForeignRequest } from "@/http/requestGuard";

const allowed = new Set(["127.0.0.1", "localhost"]);

// Over a real socket, because the guard reads the Host through `request.url`, and whether Bun
// builds that URL from the Host header is the assumption the whole check rests on.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => refuseForeignRequest(request, allowed) ?? new Response("routed"),
});
afterAll(() => server.stop(true));
const at = (path: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { headers });

test("a rebound host name is refused before any route", async () => {
  // DNS rebinding: an attacker's name pointed at 127.0.0.1 still sends that name.
  const response = await at("/api/config", { host: "evil.example" });
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe("host-not-allowed");
});

test("another site's page is refused, another localhost port included", async () => {
  for (const fetchedBy of ["cross-site", "same-site"]) {
    expect((await at("/api/config", { "sec-fetch-site": fetchedBy })).status).toBe(403);
  }
});

test("the panel's proxied requests and the host's own clients reach the routes", async () => {
  expect(await (await at("/api/config", { "sec-fetch-site": "same-origin" })).text()).toBe("routed");
  expect(await (await at("/api/config", { host: `localhost:${server.port}` })).text()).toBe("routed");
  expect(await (await at("/api/config")).text()).toBe("routed");
});
