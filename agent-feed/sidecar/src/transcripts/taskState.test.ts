import { describe, expect, test } from "bun:test";
import { parseTaskState } from "@/transcripts/taskState";

const BLOCK = [
  "<task-state>",
  "task: close idle opencode panes",
  "- judge busy from the serve's active list",
  "- dry run against live panes, then turn it on",
  "</task-state>",
  "",
  "Reading the sweep first.",
].join("\n");

describe("reading a task-state block", () => {
  test("takes the goal and its decisions from a text that opens with one", () => {
    expect(parseTaskState(`\n${BLOCK}`, 5)).toEqual({
      task: "close idle opencode panes",
      lines: ["judge busy from the serve's active list", "dry run against live panes, then turn it on"],
      at: 5,
    });
  });

  test("takes a block with no decisions under its goal", () => {
    expect(parseTaskState("<task-state>\ntask: rename the key\n</task-state>", 1)).toEqual({ task: "rename the key", lines: [], at: 1 });
  });

  // A block further into a message is somebody quoting the format, not this session reporting.
  test("ignores a block that does not open the text, one never closed, and one with no goal", () => {
    expect(parseTaskState(`Here is the format:\n${BLOCK}`, 1)).toBeNull();
    expect(parseTaskState("<task-state>\ntask: half written", 1)).toBeNull();
    expect(parseTaskState("<task-state>\n- a decision\n</task-state>", 1)).toBeNull();
  });

  test("keeps at most four decisions, and cuts an overlong one rather than dropping it", () => {
    const many = ["<task-state>", "task: t", ...["a", "b", "c", "d", "e"].map((x) => `- ${x}`), `- ${"x".repeat(200)}`, "</task-state>"];
    expect(parseTaskState(many.join("\n"), 1)?.lines).toEqual(["a", "b", "c", "d"]);
    const long = parseTaskState(`<task-state>\ntask: t\n- ${"y".repeat(200)}\n</task-state>`, 1);
    expect(long?.lines[0]).toHaveLength(120);
    expect(long?.lines[0]?.endsWith("…")).toBe(true);
  });
});
