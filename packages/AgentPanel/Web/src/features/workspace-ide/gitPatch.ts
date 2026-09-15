// A unified patch, as rows something can draw.
//
// The parsing is here rather than in the component for the reason every other rule in this file is
// git's rather than ours: what a leading `+` means depends entirely on where in the patch it sits.
// Inside a hunk it is an added line; in the header, `+++ b/path` is the file's name; and a line of
// context that happens to begin with `+` is indented by one space first, so the character that
// classifies a row is never the first character of what the reader typed.

export type PatchLineKind = "hunk" | "added" | "removed" | "context" | "meta";

export interface PatchLine {
  kind: PatchLineKind;
  /** The line as it is drawn, with the leading marker cut off an added, removed or context line. */
  text: string;
  /** Its number in the file before the commit, or null for an added line and a hunk header. */
  oldNumber: number | null;
  /** Its number in the file after the commit, or null for a removed line and a hunk header. */
  newNumber: number | null;
}

/** `@@ -<old start>,<old count> +<new start>,<new count> @@ <section>`, counts optional. */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Turn a patch into rows, dropping the header git puts above the first hunk.
 *
 * The header is dropped rather than drawn because every line of it restates something the row
 * above the diff already says -- which file, which blob, which mode -- and the panel has one
 * column to spend. The exception is a patch with NO hunk at all: a binary file, a pure rename, a
 * mode change. There the header is the whole answer, so it is kept and marked `meta` rather than
 * leaving the reader with an empty box that looks like a failure.
 */
export function parsePatch(patch: string): PatchLine[] {
  const lines = patch.split("\n");
  // A trailing newline ends the last line rather than starting an empty one.
  if (lines[lines.length - 1] === "") lines.pop();
  const first = lines.findIndex((line) => HUNK.test(line));
  if (first < 0) return headerOnly(lines);

  const rows: PatchLine[] = [];
  let oldNumber = 0;
  let newNumber = 0;
  for (const line of lines.slice(first)) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNumber = Number.parseInt(hunk[1]!, 10);
      newNumber = Number.parseInt(hunk[2]!, 10);
      rows.push({ kind: "hunk", text: line, oldNumber: null, newNumber: null });
      continue;
    }
    // `\ No newline at end of file` is a note about the line above, not a line of either file.
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line.slice(2), oldNumber: null, newNumber: null });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "added", text: line.slice(1), oldNumber: null, newNumber });
      newNumber += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "removed", text: line.slice(1), oldNumber, newNumber: null });
      oldNumber += 1;
      continue;
    }
    // Anything else is context, including the empty string: git writes an unchanged blank line as
    // a single space, and some tools drop that space, so an empty line here is a blank context row
    // rather than something to skip.
    rows.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldNumber, newNumber });
    oldNumber += 1;
    newNumber += 1;
  }
  return rows;
}

/**
 * A patch with no hunks: keep what git said about the file and drop what only repeats its path.
 *
 * `diff --git`, `index`, `---` and `+++` are the four lines that say nothing a reader of this panel
 * cannot already see in the row they clicked.
 */
function headerOnly(lines: readonly string[]): PatchLine[] {
  return lines
    .filter((line) =>
      line !== ""
      && !line.startsWith("diff --git")
      && !line.startsWith("index ")
      && !line.startsWith("--- ")
      && !line.startsWith("+++ "))
    .map((line) => ({ kind: "meta" as const, text: line, oldNumber: null, newNumber: null }));
}
