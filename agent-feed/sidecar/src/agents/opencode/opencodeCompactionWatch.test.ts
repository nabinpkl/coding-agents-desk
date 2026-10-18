import { expect, test } from "bun:test";
import { OpencodeCompactionWatch } from "@/agents/opencode/opencodeCompactionWatch";

test("a compaction streams its summary beside the thread, then ends", () => {
  const watch = new OpencodeCompactionWatch();
  const changes: Array<[string, boolean]> = [];
  const summaries: Array<[string, string, boolean]> = [];
  watch.onChange((id, active) => changes.push([id, active]));
  watch.onSummary((id, text, replace) => summaries.push([id, text, replace]));

  expect(watch.isCompacting("ses-1")).toBe(false);
  expect(watch.summary("ses-1")).toBeNull();

  watch.begin("msg-1", "ses-1");
  // The opening snapshot carries no text yet: the notice goes up empty, deltas fill it.
  expect(watch.isCompacting("ses-1")).toBe(true);
  expect(watch.summary("ses-1")).toBe("");

  expect(watch.appendToSession("ses-1", "## Summary")).toBe(true);
  expect(watch.appendToSession("ses-1", " done")).toBe(true);
  expect(watch.summary("ses-1")).toBe("## Summary done");

  watch.end("msg-1");
  expect(watch.isCompacting("ses-1")).toBe(false);
  expect(watch.summary("ses-1")).toBeNull();

  expect(changes).toEqual([
    ["ses-1", true],
    ["ses-1", false],
  ]);
  expect(summaries).toEqual([
    ["ses-1", "## Summary", false],
    ["ses-1", " done", false],
  ]);
});

test("a retry replaces the stale summary instead of appending to it", () => {
  const watch = new OpencodeCompactionWatch();
  const changes: Array<[string, boolean]> = [];
  const summaries: Array<[string, string, boolean]> = [];
  watch.onChange((id, active) => changes.push([id, active]));
  watch.onSummary((id, text, replace) => summaries.push([id, text, replace]));

  watch.begin("msg-1", "ses-1");
  watch.appendToSession("ses-1", "stale");
  // A second compaction on the same session is a retry: one notice, and the new
  // summary replaces the old one rather than continuing it.
  watch.begin("msg-2", "ses-1");
  watch.appendToSession("ses-1", "fresh");
  // Ending the stale one changes nothing while the retry is newest.
  watch.end("msg-1");
  expect(watch.isCompacting("ses-1")).toBe(true);
  expect(watch.summary("ses-1")).toBe("fresh");

  watch.end("msg-2");
  expect(watch.isCompacting("ses-1")).toBe(false);

  expect(changes).toEqual([
    ["ses-1", true],
    ["ses-1", false],
  ]);
  expect(summaries).toEqual([
    ["ses-1", "stale", false],
    ["ses-1", "fresh", false],
  ]);
});

test("deltas for an unknown compaction are dropped, not announced", () => {
  const watch = new OpencodeCompactionWatch();
  const summaries: Array<[string, string, boolean]> = [];
  watch.onSummary((id, text, replace) => summaries.push([id, text, replace]));
  expect(watch.appendToSession("ses-1", "late")).toBe(false);
  expect(summaries).toEqual([]);
  expect(watch.isCompacting("ses-1")).toBe(false);
});

test("a session-scoped delta extends the newest flow, which is the retry's", () => {
  // Deltas name only the session, so they land on whatever is newest there.
  const watch = new OpencodeCompactionWatch();
  const summaries: Array<[string, string, boolean]> = [];
  watch.onSummary((id, text, replace) => summaries.push([id, text, replace]));
  watch.begin("msg-1", "ses-1");
  watch.begin("msg-2", "ses-1");
  expect(watch.appendToSession("ses-1", "fresh")).toBe(true);
  expect(watch.summary("ses-1")).toBe("fresh");
  expect(summaries).toEqual([["ses-1", "fresh", false]]);
});
