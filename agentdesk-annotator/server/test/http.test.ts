import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { buildBrief } from "../../shared/brief.ts";
import { SERVICE_TOKEN, startHarness, type Harness } from "./harness.ts";

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(() => h.close());

const json = { "content-type": "application/json" };
const page = "https://site.example/checkout";

async function create(text = "Pad the button"): Promise<{ id: number }> {
  const r = await h.fetch("/api/v1/annotations", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ url: page, title: "Checkout", text, tag: "bug", metadata: { selector: "form > button", tagName: "BUTTON" } }),
  });
  assert.equal(r.status, 201);
  return (await r.json()) as { id: number };
}

test("/health is open; every other route needs a valid Access JWT", async () => {
  assert.equal((await h.fetch("/health", { as: null })).status, 200);
  for (const [method, p] of [
    ["GET", "/api/v1/annotations"],
    ["POST", "/api/v1/annotations"],
    ["DELETE", "/api/v1/annotations/1"],
    ["DELETE", "/api/v1/annotations?url=x"],
    ["POST", "/api/v1/annotations/1/resolve"],
    ["PUT", "/api/v1/annotations/1/screenshot"],
    ["GET", "/api/v1/annotations/1/screenshot"],
    ["POST", "/mcp"],
    ["GET", "/nope"],
  ] as const) {
    const r = await h.fetch(p, { method, as: null });
    assert.equal(r.status, 401, `${method} ${p} without JWT`);
  }
  assert.equal((await h.fetch("/api/v1/annotations", { as: { email: "stranger@example.com" } })).status, 401);
  assert.equal((await h.fetch("/api/v1/annotations", { as: { common_name: SERVICE_TOKEN } })).status, 200);
});

test("annotation lifecycle over REST acts as user", async () => {
  const { id } = await create();
  const listed = (await (await h.fetch(`/api/v1/annotations?url=${encodeURIComponent(page)}`)).json()) as Array<{ id: number }>;
  assert.ok(listed.some((a) => a.id === id));

  const resolved = (await (await h.fetch(`/api/v1/annotations/${id}/resolve`, { method: "POST" })).json()) as { status: string; resolvedBy: string };
  assert.deepEqual([resolved.status, resolved.resolvedBy], ["resolved", "user"]);

  const reopened = (await (await h.fetch(`/api/v1/annotations/${id}/reopen`, { method: "POST" })).json()) as { status: string; reopenedBy: string };
  assert.deepEqual([reopened.status, reopened.reopenedBy], ["open", "user"]);
  assert.equal((await h.fetch(`/api/v1/annotations/${id}/reopen`, { method: "POST" })).status, 409, "reopening an open annotation");

  const replied = await h.fetch(`/api/v1/annotations/${id}/replies`, { method: "POST", headers: json, body: JSON.stringify({ text: "please also fix mobile" }) });
  assert.equal(replied.status, 201);
  assert.deepEqual(((await replied.json()) as { replies: Array<{ by: string }> }).replies.map((r) => r.by), ["user"]);

  assert.equal((await h.fetch(`/api/v1/annotations/${id}`, { method: "DELETE" })).status, 204);
  assert.equal((await h.fetch(`/api/v1/annotations/${id}`, { method: "DELETE" })).status, 404);
  assert.equal((await h.fetch(`/api/v1/annotations/${id}/resolve`, { method: "POST" })).status, 404);
});

test("screenshot upload round-trips bytes and coverage summary", async () => {
  const { id } = await create("shot me");
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
  const put = await h.fetch(`/api/v1/annotations/${id}/screenshot`, {
    method: "PUT",
    headers: json,
    body: JSON.stringify({ mime: "image/jpeg", dataBase64: bytes.toString("base64"), coverage: { scanned: 5, items: [{ selector: "b", tag: "B", text: "x" }] } }),
  });
  assert.equal(put.status, 200);
  const summary = ((await put.json()) as { screenshot: { mime: string; coverageCount: number } }).screenshot;
  assert.deepEqual([summary.mime, summary.coverageCount], ["image/jpeg", 1]);
  const got = await h.fetch(`/api/v1/annotations/${id}/screenshot`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
});

test("a dragged region round-trips in metadata and reaches the brief", async () => {
  const region = { x: 40, y: 1200, width: 320, height: 180 };
  const r = await h.fetch("/api/v1/annotations", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ url: `${page}/region`, title: "Checkout", text: "Totals overlap", tag: "bug", metadata: { selector: "main", tagName: "MAIN", region } }),
  });
  assert.equal(r.status, 201);
  const { id } = (await r.json()) as { id: number };
  const got = (await (await h.fetch(`/api/v1/annotations?url=${encodeURIComponent(`${page}/region`)}`)).json()) as Array<{ id: number; metadata: { region?: unknown } }>;
  assert.deepEqual(got.find((a) => a.id === id)?.metadata.region, region);
  assert.match(buildBrief([{ text: "Totals overlap", tag: "bug", metadata: { region } }], { url: page, title: "" }), /\*\*Region:\*\* x=40 y=1200 w=320 h=180/);
});

test("validation errors are 400 with issues, not 500", async () => {
  const bad = await h.fetch("/api/v1/annotations", { method: "POST", headers: json, body: JSON.stringify({ url: "not a url", text: "" }) });
  assert.equal(bad.status, 400);
  assert.ok(((await bad.json()) as { issues: unknown[] }).issues.length >= 2);
  assert.equal((await h.fetch("/api/v1/annotations", { method: "POST", headers: json, body: "{nope" })).status, 400);
  assert.equal((await h.fetch("/api/v1/annotations/abc/resolve", { method: "POST" })).status, 400);
  assert.equal((await h.fetch("/api/v1/annotations?status=maybe")).status, 400);
  assert.equal((await h.fetch("/api/v1/annotations", { method: "DELETE" })).status, 400);
});

/** In-process: the server answers oversize uploads before reading them, and
 * over a real socket the client's write then races the close. The limit rule
 * is what is under test, so skip the socket. */
test("oversize bodies are rejected with 413", async () => {
  const headers = { ...json, "cf-access-jwt-assertion": await h.token() };
  const put = await h.app.request("/api/v1/annotations/1/screenshot", { method: "PUT", headers, body: "x".repeat(13 * 1024 * 1024) });
  assert.equal(put.status, 413);
  const mcp = await h.app.request("/mcp", { method: "POST", headers, body: "x".repeat(2 * 1024 * 1024) });
  assert.equal(mcp.status, 413);
});

test("/mcp rejects a foreign Origin but allows claude.ai and no Origin", async () => {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
  const headers = { ...json, accept: "application/json, text/event-stream" };
  const evil = await h.fetch("/mcp", { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body: JSON.stringify(init) });
  assert.equal(evil.status, 403);
  const ok = await h.fetch("/mcp", { method: "POST", headers: { ...headers, origin: "https://claude.ai" }, body: JSON.stringify(init) });
  assert.equal(ok.status, 200);
});

test("clear removes only the page's annotations", async () => {
  await create("clear a");
  await create("clear b");
  const r = await h.fetch(`/api/v1/annotations?url=${encodeURIComponent(page)}`, { method: "DELETE" });
  assert.equal(r.status, 200);
  assert.ok(((await r.json()) as { removed: number }).removed >= 2);
  assert.deepEqual(await (await h.fetch(`/api/v1/annotations?url=${encodeURIComponent(page)}`)).json(), []);
});

test("request log line carries the verified identity", async () => {
  await h.fetch("/api/v1/annotations");
  const line = h.logs.findLast((l) => l.path === "/api/v1/annotations" && l.status === 200);
  assert.equal(line?.who, "owner@example.com");
});
