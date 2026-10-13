// The panel's scroll evidence. What matters is that a batch lands as one line per event on the
// page's own clock, and that anything off the contract is refused rather than written.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelScrollRoutes, panelScrollLines } from "@/http/panelScrollRoutes";

const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

const post = (file: string, body: unknown, path = "/api/panel/scroll-diagnostics") => {
  const url = new URL(`http://127.0.0.1${path}`);
  const request = new Request(url.href, { method: "POST", body: JSON.stringify(body) });
  return createPanelScrollRoutes(file)(request, url, undefined as never);
};

test("writes one line per event, on the page's clock, with the rest as JSON", () => {
  const lines = panelScrollLines(
    { page: "ab12cd", events: [{ t: Date.UTC(2026, 9, 13, 5), kind: "strip.scroll", strip: "bot-canvas", left: 900, atEnd: true }] },
    new Date(Date.UTC(2026, 9, 13, 5, 0, 2)),
  );
  expect(lines).toEqual([
    '2026-10-13T05:00:02.000Z 2026-10-13T05:00:00.000Z page=ab12cd strip.scroll {"strip":"bot-canvas","left":900,"atEnd":true}',
  ]);
});

test("refuses a kind it does not know, a missing clock, and a page id that is not one", () => {
  expect(panelScrollLines({ page: "ab12cd", events: [{ t: 1, kind: "anything" }] })).toBe("unknown kind anything");
  expect(panelScrollLines({ page: "ab12cd", events: [{ kind: "page.load" }] })).toBe("every event needs a numeric t");
  expect(panelScrollLines({ page: "../etc", events: [] })).toBe("page must be a short id");
});

test("appends a batch to the file it was given, and answers 400 without writing on a bad one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "panel-scroll-"));
  made.push(dir);
  const file = join(dir, "panel-scroll.log");
  const ok = await post(file, { page: "p1", events: [{ t: 0, kind: "page.load" }, { t: 1, kind: "streams.down" }] })!;
  expect(ok.status).toBe(204);
  const bad = await post(file, { page: "p1", events: [{ t: 2, kind: "page.load" }, { t: 3, kind: "nope" }] })!;
  expect(bad.status).toBe(400);
  const written = readFileSync(file, "utf8").trim().split("\n");
  expect(written).toHaveLength(2);
  expect(written[1]).toContain("page=p1 streams.down {}");
});

test("leaves every other path to the routes after it", () => {
  expect(post("/unused", {}, "/api/supervisor")).toBeUndefined();
});
