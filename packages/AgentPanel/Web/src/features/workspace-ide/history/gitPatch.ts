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
 * Where one patch row's colours come from: which version of the file, and which line of it.
 *
 * Null for a hunk header and for git's own notes, which are not lines of either file and have no
 * grammar to be read with.
 */
export type PatchPlace = { side: "old" | "new"; line: number } | null;

export interface PatchSides {
  /** The file as it was, in patch order: context and removed lines, one per line. */
  oldCode: string;
  /** The file as it became: context and added lines. */
  newCode: string;
  /** One entry per row of the patch, in the same order. */
  places: PatchPlace[];
}

/**
 * Split a patch back into the two versions of the file it describes.
 *
 * For syntax highlighting, which needs code rather than a diff. Highlighting the patch AS a patch
 * is what shiki's `diff` grammar does, and it answers a different question: it colours the `+` and
 * the `-`, which the tint already says, and leaves the code inside them grey.
 *
 * Each side is tokenized whole rather than line by line, because a grammar is stateful: a string
 * that opens on one line and closes on the next is one token to a tokenizer and two unrelated
 * fragments to a per-line one, which is how a diff ends up with half a file painted as a comment.
 * Interleaving the two sides into one pass would do the same thing -- an added line and the
 * removed line above it are two versions of one line, not two consecutive ones.
 *
 * What this cannot recover is the file above the hunk: a patch starts mid-file, so a block comment
 * opened before it is invisible here. That is inherent to colouring a fragment, and it is why the
 * result is a fragment's colours rather than the file's.
 */
export function patchSides(lines: readonly PatchLine[]): PatchSides {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const places: PatchPlace[] = [];
  for (const line of lines) {
    if (line.kind === "removed") {
      places.push({ side: "old", line: oldLines.length });
      oldLines.push(line.text);
      continue;
    }
    if (line.kind === "added") {
      places.push({ side: "new", line: newLines.length });
      newLines.push(line.text);
      continue;
    }
    if (line.kind === "context") {
      // In both files, and read from the new one: a context line is unchanged by definition, so
      // either side gives the same colours, and the new side is the one a reader is looking at.
      oldLines.push(line.text);
      places.push({ side: "new", line: newLines.length });
      newLines.push(line.text);
      continue;
    }
    places.push(null);
  }
  return { oldCode: oldLines.join("\n"), newCode: newLines.join("\n"), places };
}

/**
 * A patch with no hunks: keep what git said about the file and drop what only repeats its path.
 *
 * `diff --git`, `index`, `---` and `+++` are the four lines that say nothing a reader of this panel
 * cannot already see in the row they clicked.
 */
function headerOnly(lines: readonly string[]): PatchLine[] {
  return lines
    .filter(
      (line) =>
        line !== "" &&
        !line.startsWith("diff --git") &&
        !line.startsWith("index ") &&
        !line.startsWith("--- ") &&
        !line.startsWith("+++ "),
    )
    .map((line) => ({ kind: "meta" as const, text: line, oldNumber: null, newNumber: null }));
}
