import { describe, expect, test } from "vitest";
import { applyProseHtml, trailingTextEdit } from "./patchProse";

describe("trailingTextEdit", () => {
  test("recognizes characters appended inside the last element", () => {
    expect(trailingTextEdit("<p>Read</p>", "<p>Readi</p>")).toEqual({ removed: "", added: "i" });
    // The trailing newline marked puts between block elements is not text after the
    // edit, so it does not stop the patch.
    expect(trailingTextEdit("<p>Reading the</p>\n", "<p>Reading the f</p>\n")).toEqual({
      removed: "",
      added: " f",
    });
  });

  test("recognizes a shrinking tail", () => {
    // `markdownSafePrefix` pulls the boundary back when a marker opens, so the
    // revealed text can lose characters between two ticks.
    expect(trailingTextEdit("<p>Done. th</p>", "<p>Done. </p>")).toEqual({
      removed: "th",
      added: "",
    });
  });

  test("refuses an edit that changes structure", () => {
    // A marker closing turns text into an element: same trailing position, new shape.
    expect(trailingTextEdit("<p>A bold</p>", "<p>A <strong>bold</strong></p>")).toBeNull();
    // A new paragraph.
    expect(trailingTextEdit("<p>one</p>\n", "<p>one</p>\n<p>two</p>\n")).toBeNull();
  });

  test("refuses an edit involving an entity", () => {
    // `&amp;` is five characters of markup for one character of text, so a text-node
    // patch computed from the HTML would be the wrong length.
    expect(trailingTextEdit("<p>a </p>", "<p>a &amp;</p>")).toBeNull();
  });

  test("refuses an edit that is not at the end of the text", () => {
    expect(trailingTextEdit("<p>ab</p><p>cd</p>", "<p>abX</p><p>cd</p>")).toBeNull();
  });

  test("has nothing to do for a first render or an unchanged one", () => {
    expect(trailingTextEdit("", "<p>hello</p>")).toBeNull();
    expect(trailingTextEdit("<p>hello</p>", "<p>hello</p>")).toBeNull();
  });
});

describe("applyProseHtml", () => {
  const el = () => document.createElement("div");

  test("extends the existing text node instead of rebuilding the block", () => {
    const host = el();
    applyProseHtml(host, "", "<p>Reading the</p>");
    const paragraph = host.firstElementChild;
    const text = paragraph?.firstChild;

    applyProseHtml(host, "<p>Reading the</p>", "<p>Reading the failing line</p>");

    expect(host.innerHTML).toBe("<p>Reading the failing line</p>");
    // The identity checks are the point: the styled boxes a reader is looking at
    // survive the tick, which is what stopped the flicker.
    expect(host.firstElementChild).toBe(paragraph);
    expect(paragraph?.firstChild).toBe(text);
  });

  test("keeps inline elements alive while text grows after them", () => {
    const host = el();
    const before = "<p>A <code>value</code> and</p>";
    applyProseHtml(host, "", before);
    const code = host.querySelector("code");

    applyProseHtml(host, before, "<p>A <code>value</code> and then some</p>");

    expect(host.querySelector("code")).toBe(code);
    expect(host.textContent).toBe("A value and then some");
  });

  test("patches text inside the trailing inline element", () => {
    const host = el();
    const before = "<p>A <code>val</code></p>";
    applyProseHtml(host, "", before);
    const code = host.querySelector("code");

    applyProseHtml(host, before, "<p>A <code>value</code></p>");

    expect(host.querySelector("code")).toBe(code);
    expect(host.textContent).toBe("A value");
  });

  test("replaces the block when the structure changes", () => {
    const host = el();
    const before = "<p>A bold</p>";
    applyProseHtml(host, "", before);
    const paragraph = host.firstElementChild;

    applyProseHtml(host, before, "<p>A <strong>bold</strong> claim</p>");

    expect(host.innerHTML).toBe("<p>A <strong>bold</strong> claim</p>");
    expect(host.firstElementChild).not.toBe(paragraph);
  });

  test("replaces outright when there is no recorded previous render", () => {
    // The empty `previous` is what a fresh element -- or one React handed to a
    // different block -- looks like, and it must never be patched onto whatever the
    // node happens to hold.
    const host = el();
    host.innerHTML = "<p>a block from somewhere else</p>";
    applyProseHtml(host, "", "<p>Reading</p>");
    expect(host.innerHTML).toBe("<p>Reading</p>");
  });

  test("replaces when the recorded text is not where the patch expects it", () => {
    const host = el();
    host.innerHTML = "<p>unrelated</p>";
    applyProseHtml(host, "<p>Done. th</p>", "<p>Done. </p>");
    expect(host.innerHTML).toBe("<p>Done. </p>");
  });
});
