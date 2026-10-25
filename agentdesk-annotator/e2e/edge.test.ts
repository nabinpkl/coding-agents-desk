/* End-to-end through the real Cloudflare edge: Access, tunnel, container.
 * Authenticates with the annotator-e2e service token. Everything it creates
 * lives under a unique https://e2e.invalid/<run> URL and is cleared at the end.
 *
 * Env: ANNOTATOR_URL (the deployed server, e.g. https://annotator.example.com),
 *      E2E_CF_ACCESS_CLIENT_ID, E2E_CF_ACCESS_CLIENT_SECRET. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const BASE = process.env.ANNOTATOR_URL?.replace(/\/+$/, "");
const id = process.env.E2E_CF_ACCESS_CLIENT_ID;
const secret = process.env.E2E_CF_ACCESS_CLIENT_SECRET;
if (!BASE || !id || !secret) throw new Error("ANNOTATOR_URL, E2E_CF_ACCESS_CLIENT_ID and E2E_CF_ACCESS_CLIENT_SECRET are required");
const auth = { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret };
const PAGE = `https://e2e.invalid/${Date.now()}`;
const P = "agentdesk-annotator";

let client: Client;

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}/api/v1${path}`, { ...init, headers: { ...auth, "content-type": "application/json", ...init.headers } });
}

before(async () => {
  client = new Client({ name: "annotator-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: auth } }));
});

after(async () => {
  await api(`/annotations?url=${encodeURIComponent(PAGE)}`, { method: "DELETE" });
  await client.close();
});

test("the edge demands OAuth before anything reaches the origin", async () => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  const meta = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.ok(meta.registration_endpoint);
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
});

test("MCP over the edge: eight tools, full annotation round trip", async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 8);

  const created = await api("/annotations", {
    method: "POST",
    body: JSON.stringify({ url: PAGE, title: "E2E", text: "e2e: tighten spacing", tag: "suggestion", metadata: { selector: "main > section", tagName: "SECTION" } }),
  });
  assert.equal(created.status, 201);
  const { id: annId } = (await created.json()) as { id: number };

  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 0xff, 0xd9]);
  const put = await api(`/annotations/${annId}/screenshot`, {
    method: "PUT",
    body: JSON.stringify({ mime: "image/jpeg", dataBase64: bytes.toString("base64"), coverage: { scanned: 2, items: [{ selector: "main > section > h2", tag: "H2", text: "Plans" }] } }),
  });
  assert.equal(put.status, 200);
  const got = await api(`/annotations/${annId}/screenshot`);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);

  const text = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: `${P}_${name}`, arguments: args })) as { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean };
    assert.ok(!r.isError, `${name} returned an error: ${r.content[0]?.text}`);
    return r;
  };
  const listed = JSON.parse((await text("list", { url: PAGE })).content[0]!.text!) as Array<{ id: number }>;
  assert.deepEqual(listed.map((a) => a.id), [annId]);
  assert.equal(JSON.parse((await text("get", { id: annId })).content[0]!.text!).text, "e2e: tighten spacing");
  assert.ok((await text("brief", { url: PAGE })).content[0]!.text!.includes("tighten spacing"));
  const shot = await text("screenshot", { id: annId });
  assert.deepEqual(Buffer.from(shot.content[0]!.data!, "base64"), bytes);
  assert.equal(JSON.parse((await text("elements", { id: annId, tag: "h2" })).content[0]!.text!).returned, 1);
  const replied = JSON.parse((await text("reply", { id: annId, message: "e2e agent reply" })).content[0]!.text!);
  assert.deepEqual([replied.status, replied.replies.at(-1).by], ["open", "agent"]);
  const resolved = JSON.parse((await text("resolve", { id: annId, message: "e2e resolved" })).content[0]!.text!);
  assert.deepEqual([resolved.status, resolved.resolvedBy], ["resolved", "agent"]);
  const reopened = JSON.parse((await text("reopen", { id: annId })).content[0]!.text!);
  assert.equal(reopened.status, "open");

  const reply = await api(`/annotations/${annId}/replies`, { method: "POST", body: JSON.stringify({ text: "e2e user reply" }) });
  assert.equal(reply.status, 201);
  assert.equal((await api(`/annotations/${annId}`, { method: "DELETE" })).status, 204);
  assert.equal((await api(`/annotations/${annId}`, { method: "DELETE" })).status, 404);
});
