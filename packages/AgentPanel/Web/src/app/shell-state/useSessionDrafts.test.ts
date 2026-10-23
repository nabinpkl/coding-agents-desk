import { describe, expect, it } from "vitest";
import { askAboutPrompt } from "@/app/shell-state/useSessionDrafts";

describe("the first turn of a fork that asks about a passage", () => {
  it("says what the fork is for, quotes every line of the passage, and ends on the question", () => {
    expect(askAboutPrompt("first line\nsecond line", "  What does this mean? ")).toBe(
      [
        "You are a fork of the conversation above, started only to answer a question about one passage in it.",
        "Answer the question and stop. You may read files and search to answer it, but change nothing, and do " +
          "not carry on with the conversation's work: the session you were forked from carries on without you.",
        "",
        "The passage:",
        "",
        "> first line",
        "> second line",
        "",
        "What does this mean?",
      ].join("\n"),
    );
  });
});
