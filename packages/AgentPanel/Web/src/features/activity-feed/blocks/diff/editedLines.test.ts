import { describe, expect, it } from "vitest";
import { findWritten, writtenText } from "@/features/activity-feed/blocks/diff/editedLines";

describe("writtenText", () => {
  it("marks only the lines that differ, not the context kept on either side", () => {
    expect(writtenText("a\nb\nc", "a\nB\nB2\nc")).toEqual({ text: "a\nB\nB2\nc", from: 1, to: 3 });
  });

  it("marks a line changed inside it", () => {
    expect(writtenText("const x = 1;", "const x = 2;")).toEqual({ text: "const x = 2;", from: 0, to: 1 });
  });

  it("marks lines added at the end, after the kept ones", () => {
    expect(writtenText("a\nb", "a\nb\nc")).toEqual({ text: "a\nb\nc", from: 2, to: 3 });
  });

  it("marks none for an edit that only took lines out, and says where", () => {
    expect(writtenText("a\nb\nc", "a\nc")).toEqual({ text: "a\nc", from: 1, to: 1 });
  });

  it("has nothing to find when the edit wrote nothing", () => {
    expect(writtenText("a\nb", "")).toBeNull();
  });
});

describe("findWritten", () => {
  const file = "one\ntwo\nthree\nfour\nfive\n";

  it("finds the changed lines in the file as it is now", () => {
    expect(findWritten(file, { text: "two\nthree\nfour", from: 1, to: 2 })).toEqual({ line: 3, through: 3 });
  });

  it("counts from the line the text starts on, even part way along it", () => {
    expect(findWritten(file, { text: "ee\nfour", from: 1, to: 2 })).toEqual({ line: 4, through: 4 });
    expect(findWritten(file, { text: "one", from: 0, to: 1 })).toEqual({ line: 1, through: 1 });
  });

  it("gives an empty span where an edit only took lines out", () => {
    expect(findWritten(file, { text: "two\nthree", from: 1, to: 1 })).toEqual({ line: 3, through: 2 });
  });

  it("finds nothing once the text has left the file", () => {
    expect(findWritten(file, { text: "six", from: 0, to: 1 })).toBeNull();
  });
});
