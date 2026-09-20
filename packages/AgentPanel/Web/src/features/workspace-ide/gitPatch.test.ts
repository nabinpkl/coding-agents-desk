import { expect, it } from "vitest";
import { parsePatch, patchSides } from "@/features/workspace-ide/gitPatch";

const PATCH = [
  "diff --git a/src/main.ts b/src/main.ts",
  "index 1234567..89abcde 100644",
  "--- a/src/main.ts",
  "+++ b/src/main.ts",
  "@@ -4,6 +4,7 @@ export function main() {",
  " const first = 1;",
  "-const second = 2;",
  "+const second = 3;",
  "+const third = 4;",
  " return first;",
  "",
].join("\n");

it("drops the header and numbers each side from the hunk it is in", () => {
  const rows = parsePatch(PATCH);
  expect(rows.map((row) => row.kind))
    .toEqual(["hunk", "context", "removed", "added", "added", "context"]);
  expect(rows.map((row) => [row.oldNumber, row.newNumber])).toEqual([
    [null, null],
    [4, 4],
    // A removed line exists only in the old file, an added line only in the new one, so each row
    // carries one number. Both sides advance past the pair, which is what keeps the last row's
    // numbers apart.
    [5, null],
    [null, 5],
    [null, 6],
    [6, 7],
  ]);
});

it("cuts the marker off, so a line that begins with a plus survives being context", () => {
  const rows = parsePatch([
    "@@ -1,2 +1,2 @@",
    " +indented by git, typed by nobody",
    "+++added",
  ].join("\n"));
  expect(rows[1]).toMatchObject({ kind: "context", text: "+indented by git, typed by nobody" });
  expect(rows[2]).toMatchObject({ kind: "added", text: "++added" });
});

it("keeps the header when there is no hunk, which is all a binary change has", () => {
  const rows = parsePatch([
    "diff --git a/logo.png b/logo.png",
    "index 1234567..89abcde 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n"));
  expect(rows).toEqual([
    { kind: "meta", text: "Binary files a/logo.png and b/logo.png differ", oldNumber: null, newNumber: null },
  ]);
});

it("reads a rename with no content change, where git writes only similarity", () => {
  const rows = parsePatch([
    "diff --git a/old.ts b/new.ts",
    "similarity index 100%",
    "rename from old.ts",
    "rename to new.ts",
    "",
  ].join("\n"));
  expect(rows.map((row) => row.text))
    .toEqual(["similarity index 100%", "rename from old.ts", "rename to new.ts"]);
});

it("says the file ended without a newline instead of drawing the backslash", () => {
  const rows = parsePatch(["@@ -1 +1 @@", "-one", "+two", "\\ No newline at end of file"].join("\n"));
  expect(rows[3]).toMatchObject({ kind: "meta", text: "No newline at end of file" });
});

it("answers nothing for an empty patch, rather than one blank row", () => {
  expect(parsePatch("")).toEqual([]);
});

it("splits the rows back into the two files, so each is tokenized as code", () => {
  const sides = patchSides(parsePatch(PATCH));
  // Each side is the file as it stood, which is what a grammar can read. A single pass over the
  // rows in patch order would have the old and the new spelling of one line as two consecutive
  // lines of one file, and a tokenizer would carry state from one into the other.
  expect(sides.oldCode).toBe("const first = 1;\nconst second = 2;\nreturn first;");
  expect(sides.newCode).toBe("const first = 1;\nconst second = 3;\nconst third = 4;\nreturn first;");
  expect(sides.places).toEqual([
    null,
    { side: "new", line: 0 },
    { side: "old", line: 1 },
    { side: "new", line: 1 },
    { side: "new", line: 2 },
    { side: "new", line: 3 },
  ]);
});

it("places nothing for a patch that is all notes, which has no code to colour", () => {
  const sides = patchSides(parsePatch("Binary files a/logo.png and b/logo.png differ\n"));
  expect(sides.places).toEqual([null]);
  expect(sides.oldCode).toBe("");
});
