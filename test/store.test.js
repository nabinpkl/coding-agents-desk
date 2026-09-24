const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../store.js");

const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ax-")), "a.json");
const store = createStore(tmp);

const r1 = store.add({ url: "https://a.example/form", title: "Form", text: "Pad the button", tag: "bug", metadata: { selector: "form > button", tagName: "BUTTON" } });
assert.equal(r1.id, 1);
assert.equal(r1.status, "open");

store.add({ url: "https://b.example/", title: "Home", text: "Space the hero", tag: "suggestion", metadata: {} });

assert.equal(store.list({}).length, 2);
assert.equal(store.list({ url: "a.example" }).length, 1);
assert.equal(store.list({ status: "resolved" }).length, 0);

const got = store.get(1);
assert.equal(got.text, "Pad the button");

const brief = store.brief("a.example");
assert.ok(brief.includes("Pad the button"));
assert.ok(!brief.includes("Space the hero"));

assert.equal(store.resolve(1).status, "resolved");
assert.equal(store.get(1).resolvedBy, "agent");
assert.ok(store.get(1).updatedAt >= store.get(1).createdAt);
assert.equal(store.list({ status: "open" }).length, 1);
// Resolving bumps recency: id 1 jumps ahead of id 2.
assert.equal(store.list({})[0].id, 1);
assert.equal(store.reopen(1).status, "open");
assert.ok(store.remove(2));
assert.equal(store.list({}).length, 1);
assert.equal(store.remove(999), false);
const rep = store.addReply(1, { by: "agent", text: "Fixed in commit abc." });
assert.equal(rep.replies.length, 1);
assert.equal(rep.replies[0].by, "agent");
assert.ok(rep.updatedAt >= rep.createdAt);
assert.equal(store.addReply(999, { text: "x" }), null);
store.add({ url: "https://b.example/again", title: "", text: "Clear me", tag: "bug", metadata: {} });
assert.equal(store.clear("https://b.example"), 1);
assert.equal(store.list({}).length, 1);
const shot = store.addScreenshot(1, { file: "shot-1.jpg", coverage: { scanned: 10, items: [{ selector: "div.a", tag: "DIV", text: "hi" }] } });
assert.equal(shot.metadata.screenshot, "shot-1.jpg");
assert.equal(shot.coverage.items.length, 1);
assert.equal(store.addScreenshot(999, { file: "x", coverage: {} }), null);
assert.equal(store.get(999), null);
assert.equal(store.resolve(999), null);

fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
console.log("store.test.js ok");
