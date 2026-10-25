// Where an edit's change is in its file as the file stands now, so the code viewer can open there
// and mark it rather than at the top.
//
// The transcript keeps what the edit replaced and what it wrote, never where in the file that was,
// so the place is found by searching the file for the text the edit wrote. That text usually
// carries a line or two the edit kept on each side (an edit's old text has to be unique in the
// file, so agents include context), and those are found with it but not marked: only the lines
// that differ from what was there before are the change.

/**
 * What an edit wrote into a file: `text` exactly as written, and `[from, to)` the lines of it that
 * changed, counted from 0. `from === to` is an edit that only took lines out, between `from - 1`
 * and `from`.
 */
export interface WrittenText {
  text: string;
  from: number;
  to: number;
}

/** The text an edit wrote and its changed lines, or null when it wrote nothing to find. */
export function writtenText(oldText: string, newText: string): WrittenText | null {
  if (newText === "") return null;
  const before = oldText.split("\n");
  const after = newText.split("\n");
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
  let kept = 0;
  while (
    kept < before.length - from &&
    kept < after.length - from &&
    before[before.length - 1 - kept] === after[after.length - 1 - kept]
  ) {
    kept += 1;
  }
  return { text: newText, from, to: after.length - kept };
}

/**
 * The file's lines the change is on now, one-based: `line` to `through`, inclusive, which is
 * `line - 1` for an edit that only took lines out. Null when the text is no longer in the file,
 * because a later edit changed it or it was reverted. Where it appears more than once, the first.
 */
export function findWritten(fileText: string, written: WrittenText): { line: number; through: number } | null {
  const at = fileText.indexOf(written.text);
  if (at === -1) return null;
  let first = 1;
  for (let index = fileText.indexOf("\n"); index !== -1 && index < at; index = fileText.indexOf("\n", index + 1)) {
    first += 1;
  }
  return { line: first + written.from, through: first + written.to - 1 };
}
