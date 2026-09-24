import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAnnotationService, NotFound } from "../src/service/annotations.ts";
import { openSqliteStore } from "../src/store/sqlite-store.ts";

function setup() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "annotator-svc-")), "annotator.db");
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const store = openSqliteStore(file);
  return { svc: createAnnotationService(store, clock), store };
}

const input = { url: "https://a.example/form", title: "Form", text: "Pad the button", tag: "bug" as const, metadata: { selector: "form > button", tagName: "BUTTON" } };

test("resolve records who and when; reopen clears it and records who reopened", () => {
  const { svc } = setup();
  const a = svc.add(input);
  const r = svc.resolve(a.id, "agent");
  assert.equal(r.status, "resolved");
  assert.equal(r.resolvedBy, "agent");
  assert.ok(r.resolvedAt);
  assert.ok(r.updatedAt > a.updatedAt);
  const o = svc.reopen(a.id, "user");
  assert.equal(o.status, "open");
  assert.equal(o.resolvedBy, null);
  assert.equal(o.resolvedAt, null);
  assert.equal(o.reopenedBy, "user");
});

test("resolve and reopen with a message append a reply atomically", () => {
  const { svc } = setup();
  const a = svc.add(input);
  const r = svc.resolve(a.id, "agent", "Fixed padding in Button.tsx");
  assert.deepEqual(r.replies.map((x) => [x.by, x.text]), [["agent", "Fixed padding in Button.tsx"]]);
  const o = svc.reopen(a.id, "agent", "Blocked: cannot find the component");
  assert.equal(o.replies.length, 2);
});

test("every mutation on a missing id throws NotFound", () => {
  const { svc } = setup();
  assert.throws(() => svc.get(99), NotFound);
  assert.throws(() => svc.resolve(99, "agent"), NotFound);
  assert.throws(() => svc.reopen(99, "agent"), NotFound);
  assert.throws(() => svc.reply(99, "user", "x"), NotFound);
  assert.throws(() => svc.remove(99), NotFound);
  assert.throws(() => svc.attachScreenshot(99, { mime: "image/jpeg", bytes: new Uint8Array([1]), coverage: { scanned: 0, items: [] } }), NotFound);
  assert.throws(() => svc.getScreenshot(99), NotFound);
  assert.throws(() => svc.elements(99, {}), NotFound);
});

test("a failed resolve-with-message leaves nothing half written", () => {
  const { svc, store } = setup();
  const a = svc.add(input);
  const original = store.addReply;
  store.addReply = () => {
    throw new Error("disk full");
  };
  assert.throws(() => svc.resolve(a.id, "agent", "done"), /disk full/);
  store.addReply = original;
  assert.equal(svc.get(a.id).status, "open");
});

test("getScreenshot on an annotation without one throws NotFound", () => {
  const { svc } = setup();
  const a = svc.add(input);
  assert.throws(() => svc.getScreenshot(a.id), NotFound);
});

test("elements filters coverage by substring and exact tag, with a bounded limit", () => {
  const { svc } = setup();
  const a = svc.add(input);
  const items = [
    { selector: "div.card > button.save", tag: "BUTTON", text: "Save" },
    { selector: "div.card > span", tag: "SPAN", text: "Unsaved changes" },
    ...Array.from({ length: 60 }, (_, i) => ({ selector: `li:nth-of-type(${i + 1})`, tag: "LI", text: `row ${i}` })),
  ];
  svc.attachScreenshot(a.id, { mime: "image/jpeg", bytes: new Uint8Array([1]), coverage: { scanned: 100, items } });
  assert.equal(svc.elements(a.id, { tag: "button" }).returned, 1);
  assert.equal(svc.elements(a.id, { contains: "SAVE" }).returned, 2);
  const all = svc.elements(a.id, {});
  assert.equal(all.total, 62);
  assert.equal(all.returned, 40);
  assert.equal(svc.elements(a.id, { limit: 1000 }).returned, 62);
  assert.equal(svc.elements(a.id, { limit: 0 }).returned, 1);
});

test("elements on an annotation without a screenshot returns an empty set", () => {
  const { svc } = setup();
  const a = svc.add(input);
  assert.deepEqual(svc.elements(a.id, {}), { total: 0, returned: 0, items: [] });
});

test("brief covers only open items for the url filter", () => {
  const { svc } = setup();
  const a = svc.add(input);
  svc.add({ ...input, url: "https://b.example/", text: "Space the hero", tag: "suggestion" });
  const done = svc.add({ ...input, text: "Already fixed" });
  svc.resolve(done.id, "agent");
  const md = svc.brief("a.example");
  assert.ok(md.includes("Pad the button"));
  assert.ok(md.includes("form > button"));
  assert.ok(!md.includes("Space the hero"));
  assert.ok(!md.includes("Already fixed"));
  assert.ok(md.includes("**Items:** 1"));
  assert.ok(svc.brief().includes("**Items:** 2"));
  assert.equal(a.id, 1);
});

test("clearByUrl rejects an empty url instead of wiping everything", () => {
  const { svc } = setup();
  svc.add(input);
  assert.throws(() => svc.clearByUrl(""), /url required/);
  assert.equal(svc.clearByUrl("https://a.example/form"), 1);
});
