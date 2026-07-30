import { describe, expect, test } from "vitest";

import { wordDiff } from "@/features/voice/word-diff";

describe("wordDiff", () => {
  test("keeps shared words and labels both sides of a recognition difference", () => {
    expect(wordDiff("Hello. How would you?", "Hello. How are you?")).toEqual([
      { kind: "same", text: "Hello." },
      { kind: "same", text: "How" },
      { kind: "machine-only", text: "would" },
      { kind: "intended-only", text: "are" },
      { kind: "same", text: "you?" },
    ]);
  });

  test("handles a missing machine transcript without inventing text", () => {
    expect(wordDiff("", "Hello there")).toEqual([
      { kind: "intended-only", text: "Hello" },
      { kind: "intended-only", text: "there" },
    ]);
  });
});
