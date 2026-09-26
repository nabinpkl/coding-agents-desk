/* Send, end to end through the real app and the real hub client, against the
 * fake edge in the harness. What is being pinned: the brief and refs the agent
 * receives, the link written back to each annotation, the state readout, and
 * that a send which never reached the hub leaves no trace claiming it did. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { afterEach, describe, it } from "node:test";
import { startHarness, type Harness } from "./harness.ts";

const PAGE = "https://shop.example/cart";

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(async () => {
  await h.close();
});
afterEach(() => {
  // Tests that assert "nothing was sent" need the record to start empty.
  (h.hub as unknown as { sent: unknown[] }).sent.length = 0;
});

async function annotate(text: string, url = PAGE): Promise<number> {
  const res = await h.fetch("/api/v1/annotations", {
    method: "POST",
    body: JSON.stringify({ url, title: "Cart", text, tag: "bug", metadata: { selector: "button.buy", tagName: "BUTTON" } }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { id: number }).id;
}

describe("recipients", () => {
  it("offers the sessions and the Bot they belong to, and never the owner", async () => {
    const res = await h.fetch("/api/v1/recipients");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ address: string; name: string; related: string[] }>;
    // `human` is this surface: offering it would let a reader message themselves.
    assert.ok(!body.some((r) => r.address === "human"));
    // The Bot stays, because the panel groups its sessions under it.
    assert.ok(body.some((r) => r.address === "bot:site"));
    const ses = body.find((r) => r.address === "opencode:ses_1");
    assert.deepEqual(ses?.related, ["bot:site"]);
  });

  it("needs the owner's token like every other route", async () => {
    const res = await h.fetch("/api/v1/recipients", { as: null });
    assert.equal(res.status, 401);
  });
});

describe("send", () => {
  it("posts one request as the owner, with the brief and a ref per annotation", async () => {
    const first = await annotate("The buy button does nothing");
    const second = await annotate("Total is wrong after removing an item");
    const res = await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [first, second], to: "opencode:ses_1" }) });
    assert.equal(res.status, 201);
    const out = (await res.json()) as { messageId: string; to: string; toName: string; state: string; annotationIds: number[] };
    assert.equal(out.to, "opencode:ses_1");
    assert.equal(out.toName, "Fix the header");
    assert.equal(out.state, "queued");
    assert.deepEqual(out.annotationIds, [first, second]);

    assert.equal(h.hub.sent.length, 1, "two annotations, one message");
    const posted = h.hub.sent[0]!;
    assert.equal(posted.as, "human", "the panel speaks as the owner, not as a service");
    assert.equal(posted.kind, "request");
    assert.equal(posted.to, "opencode:ses_1");
    const body = String(posted.body);
    assert.match(body, /The buy button does nothing/);
    assert.match(body, /Total is wrong after removing an item/);
    assert.match(body, new RegExp(PAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the brief names the page it came from");
    assert.deepEqual(posted.refs, [
      { app: "agentdesk-annotator", kind: "annotation", id: String(first), url: PAGE },
      { app: "agentdesk-annotator", kind: "annotation", id: String(second), url: PAGE },
    ]);
  });

  it("sends to a session with nobody at the keyboard, which queues rather than failing", async () => {
    const id = await annotate("Only shows up at night");
    const res = await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [id], to: "opencode:ses_2" }) });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as { state: string }).state, "queued");
  });

  it("refuses an address that is not in the directory, before anything is sent", async () => {
    const id = await annotate("Nowhere to go");
    const res = await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [id], to: "opencode:ghost" }) });
    assert.equal(res.status, 404);
    assert.match(((await res.json()) as { error: string }).error, /no such recipient/);
    assert.equal(h.hub.sent.length, 0);
  });

  it("refuses annotations from two pages, because one brief names one page", async () => {
    const here = await annotate("On the cart");
    const elsewhere = await annotate("On the login", "https://shop.example/login");
    const res = await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [here, elsewhere], to: "opencode:ses_1" }) });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /more than one page/);
    assert.equal(h.hub.sent.length, 0);
  });

  it("404s an annotation that is not there, rather than sending a brief with a hole in it", async () => {
    const res = await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [987654], to: "opencode:ses_1" }) });
    assert.equal(res.status, 404);
    assert.equal(h.hub.sent.length, 0);
  });

  it("asks for at least one annotation", async () => {
    const res = await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [], to: "opencode:ses_1" }) });
    assert.equal(res.status, 400);
  });

  it("passes the hub's own refusal back to the reader, as a 400", async () => {
    const id = await annotate("About to be refused");
    h.hub.failOnce(409, { error: "thread is at 40 messages; start a new one" });
    const res = await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [id], to: "opencode:ses_1" }) });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /start a new one/);
  });

  it("reports a hub that cannot be reached as upstream, not as the reader's mistake", async () => {
    const id = await annotate("Into the void");
    h.hub.failOnce(500, { error: "boom" });
    const res = await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [id], to: "opencode:ses_1" }) });
    assert.equal(res.status, 502);
    assert.ok(h.logs.some((l) => l.hub !== undefined), "an upstream failure is logged as one");
  });

  it("records nothing when the hub never took it, so no annotation claims a send that did not happen", async () => {
    const id = await annotate("Never left");
    h.hub.failOnce(500, { error: "boom" });
    await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [id], to: "opencode:ses_1" }) });
    const res = await h.fetch(`/api/v1/sends?ids=${id}`);
    assert.deepEqual(await res.json(), []);
  });
});

describe("delivery state", () => {
  it("reports each annotation's newest send, and follows the message as it moves", async () => {
    const id = await annotate("Watch this one move");
    const sent = (await (await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [id], to: "opencode:ses_1" }) })).json()) as { messageId: string };

    let reads = (await (await h.fetch(`/api/v1/sends?ids=${id}`)).json()) as Array<{ annotationId: number; state: string; toName: string }>;
    assert.equal(reads.length, 1);
    assert.equal(reads[0]?.annotationId, id);
    assert.equal(reads[0]?.state, "queued");
    assert.equal(reads[0]?.toName, "Fix the header");

    h.hub.setState(sent.messageId, "delivered");
    reads = (await (await h.fetch(`/api/v1/sends?ids=${id}`)).json()) as typeof reads;
    assert.equal(reads[0]?.state, "delivered");
  });

  it("looks the state up once per message, not once per annotation", async () => {
    const ids = [await annotate("One of three"), await annotate("Two of three"), await annotate("Three of three")];
    const sent = (await (await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids, to: "opencode:ses_1" }) })).json()) as { messageId: string };
    // A second send to a different session, so the store holds two messages and the count is visible.
    await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [ids[0]], to: "opencode:ses_2" }) });
    h.hub.setState(sent.messageId, "answered");
    const res = await h.fetch(`/api/v1/sends?ids=${ids.join(",")}`);
    const body = (await res.json()) as Array<{ annotationId: number; state: string }>;
    assert.equal(body.length, 3);
    // ids[0] was sent twice, so it reports only its newest.
    assert.equal(body.filter((s) => s.annotationId === ids[0]).length, 1);
    assert.equal(body.find((s) => s.annotationId === ids[0])?.state, "queued");
    assert.equal(body.find((s) => s.annotationId === ids[1])?.state, "answered");
  });

  it("says the hub is down rather than showing an unknown state as if it were a real one", async () => {
    const id = await annotate("State we cannot read");
    await h.fetch("/api/v1/send", { method: "POST", body: JSON.stringify({ ids: [id], to: "opencode:ses_1" }) });
    h.hub.failOnce(503, { error: "restarting" });
    const res = await h.fetch(`/api/v1/sends?ids=${id}`);
    assert.equal(res.status, 502);
  });

  it("rejects a malformed id list rather than guessing", async () => {
    const res = await h.fetch("/api/v1/sends?ids=abc");
    assert.equal(res.status, 400);
  });
});
