import { describe, expect, test } from "bun:test";
import { parseSpokenStatus, questionStatus } from "@/transcripts/spokenStatus";

const SUGGESTIONS = "<next-suggestions-for-user>\n\n1. One.\n\n2. Two.\n\n3. Three.\n\n</next-suggestions-for-user>";

describe("a spoken status block", () => {
  test("is read from the end of a response, kinds and all, in the order written", () => {
    const text = `Done.\n\n<spoken-status>\nwaiting: say go to rebuild\ndone: slider reaches four times\n</spoken-status>\n\n${SUGGESTIONS}`;
    expect(parseSpokenStatus(text, 5)).toEqual({
      lines: [
        { kind: "waiting", text: "say go to rebuild" },
        { kind: "done", text: "slider reaches four times" },
      ],
      at: 5,
      from: "block",
    });
  });

  test("counts only when it closes the text: one quoted mid-response is an example", () => {
    const text = "Here is the format:\n\n<spoken-status>\ndone: example\n</spoken-status>\n\nMore prose after it.";
    expect(parseSpokenStatus(text, 0)).toBeNull();
  });

  test("keeps a line with no known kind as a note, and stops at four lines", () => {
    const text = "<spoken-status>\n- Done: a\nsomething plain\nfailed: b\nrunning: c\nnote: d\n</spoken-status>";
    expect(parseSpokenStatus(text, 0)?.lines).toEqual([
      { kind: "done", text: "a" },
      { kind: "note", text: "something plain" },
      { kind: "failed", text: "b" },
      { kind: "running", text: "c" },
    ]);
  });

  test("an empty block says nothing", () => {
    expect(parseSpokenStatus("<spoken-status>\n\n</spoken-status>", 0)).toBeNull();
  });
});

describe("a pending question", () => {
  test("is one waiting line, counting the questions after the first", () => {
    expect(questionStatus(["Rebuild the host now?", "Which port?"], 3)).toEqual({
      lines: [{ kind: "waiting", text: "Rebuild the host now? (and 1 more question)" }],
      at: 3,
      from: "question",
    });
  });
});
