import { describe, expect, test } from "bun:test";
import { CompactionWatch } from "@/live/claudeCompactionWatch";

/** One captured stream delta, as the observer hands it over. */
const text = (value: string): string =>
  JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } });

function watching() {
  const watch = new CompactionWatch();
  const active: Array<[string, boolean]> = [];
  const summaries: Array<[string, string, boolean]> = [];
  watch.onChange((id, on) => active.push([id, on]));
  watch.onSummary((id, value, replace) => summaries.push([id, value, replace]));
  return { watch, active, summaries };
}

describe("CompactionWatch summary", () => {
  test("starts from what streamed before the flow was recognised, and grows from there", () => {
    // A summariser writes at once, and its request body is read back after its first deltas.
    const { watch, active, summaries } = watching();
    watch.begin("f1", "s1", [text("Primary "), text("request")]);
    expect(watch.summary("s1")).toBe("Primary request");
    expect(watch.append("f1", text(" and intent"))).toBe(true);
    expect(watch.summary("s1")).toBe("Primary request and intent");
    expect(active).toEqual([["s1", true]]);
    expect(summaries).toEqual([["s1", "Primary request", true], ["s1", " and intent", false]]);

    watch.end("f1");
    expect(watch.summary("s1")).toBeNull();
    expect(active).toEqual([["s1", true], ["s1", false]]);
  });

  test("keeps thinking out of the summary, and leaves other flows' deltas alone", () => {
    const { watch, summaries } = watching();
    watch.begin("f1", "s1");
    const thinking = JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "not the summary" },
    });
    expect(watch.append("f1", thinking)).toBe(true);
    expect(watch.append("f1", "not json")).toBe(true);
    // A turn's delta is the mirror's to bind, which is what false tells it.
    expect(watch.append("turn", text("the session speaking"))).toBe(false);
    expect(watch.summary("s1")).toBe("");
    expect(summaries).toEqual([]);
  });

  test("a retry's summary replaces the one on screen, and ending it hands back the older", () => {
    const { watch, active, summaries } = watching();
    watch.begin("f1", "s1", [text("first")]);
    watch.begin("f2", "s1");
    expect(watch.summary("s1")).toBe("");
    // The older flow keeps writing, and nobody is shown it while the retry is the newest.
    watch.append("f1", text(" more"));
    watch.append("f2", text("second"));
    expect(summaries).toEqual([["s1", "first", true], ["s1", "", true], ["s1", "second", false]]);

    watch.end("f2");
    expect(watch.summary("s1")).toBe("first more");
    expect(summaries.at(-1)).toEqual(["s1", "first more", true]);
    expect(active).toEqual([["s1", true]]);
  });

  test("an end that arrived first leaves nothing to begin", () => {
    const { watch, active } = watching();
    watch.end("f1");
    watch.begin("f1", "s1", [text("late")]);
    expect(watch.summary("s1")).toBeNull();
    expect(active).toEqual([]);
  });
});
