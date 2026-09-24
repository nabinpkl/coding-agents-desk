import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startHarness, type Harness } from "./harness.ts";

let h: Harness;
let client: Client;
const P = "agentdesk-annotator";
const page = "https://mcp.example/pricing";

before(async () => {
  h = await startHarness();
  const jwt = await h.token();
  client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${h.base}/mcp`), { requestInit: { headers: { "cf-access-jwt-assertion": jwt } } }));
});

after(async () => {
  await client.close();
  await h.close();
});

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ content: Content; isError?: boolean }> {
  return (await client.callTool({ name: `${P}_${name}`, arguments: args })) as { content: Content; isError?: boolean };
}

function parsed(r: { content: Content }): any {
  return JSON.parse(r.content[0]!.text!);
}

async function seed(text: string): Promise<number> {
  const r = await h.fetch("/api/v1/annotations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: page, title: "Pricing", text, tag: "bug", metadata: { selector: "section.plans", tagName: "SECTION" } }),
  });
  return ((await r.json()) as { id: number }).id;
}

test("server identifies itself and lists the seven tools", async () => {
  assert.equal(client.getServerVersion()?.name, P);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["brief", "elements", "get", "list", "reopen", "resolve", "screenshot"].map((n) => `${P}_${n}`));
});

test("list, get and brief read what the extension wrote", async () => {
  const id = await seed("Plans overflow on mobile");
  const list = parsed(await call("list", { url: "mcp.example", status: "open" }));
  assert.ok(list.some((a: { id: number }) => a.id === id));
  assert.equal(parsed(await call("get", { id })).text, "Plans overflow on mobile");
  const brief = await call("brief", { url: "mcp.example" });
  assert.ok(brief.content[0]!.text!.includes("Plans overflow on mobile"));
});

test("resolve and reopen act as agent and store the message as a reply", async () => {
  const id = await seed("Fix the CTA color");
  const r = parsed(await call("resolve", { id, message: "Changed to brand blue" }));
  assert.deepEqual([r.status, r.resolvedBy, r.replies[0].by, r.replies[0].text], ["resolved", "agent", "agent", "Changed to brand blue"]);
  const o = parsed(await call("reopen", { id, message: "Blocked on design token" }));
  assert.deepEqual([o.status, o.reopenedBy, o.replies.length], ["open", "agent", 2]);
});

test("screenshot returns image content and elements filters the coverage", async () => {
  const id = await seed("Card spacing");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  await h.fetch(`/api/v1/annotations/${id}/screenshot`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mime: "image/png",
      dataBase64: bytes.toString("base64"),
      coverage: { scanned: 9, items: [{ selector: "div.card > button", tag: "BUTTON", text: "Buy" }, { selector: "div.card > p", tag: "P", text: "Monthly" }] },
    }),
  });
  const shot = await call("screenshot", { id });
  assert.equal(shot.content[0]!.type, "image");
  assert.equal(shot.content[0]!.mimeType, "image/png");
  assert.deepEqual(Buffer.from(shot.content[0]!.data!, "base64"), bytes);
  assert.ok(shot.content[1]!.text!.includes("2 of 9"));
  const els = parsed(await call("elements", { id, tag: "button" }));
  assert.deepEqual([els.total, els.returned, els.items[0].text], [2, 1, "Buy"]);
});

test("a missing id is a tool error, not a protocol failure", async () => {
  for (const name of ["get", "screenshot", "elements", "resolve", "reopen"]) {
    const r = await call(name, { id: 999999 });
    assert.equal(r.isError, true, name);
    assert.match(r.content[0]!.text!, /not found/);
  }
});
