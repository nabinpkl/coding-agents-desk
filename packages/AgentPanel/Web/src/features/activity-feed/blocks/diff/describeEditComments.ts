// Comment-aware line scanning for edit labels, one idea: finding where the
// comment starts on a line without being fooled by strings, directives, or
// prose. The scanner walks each line quote-aware so `//` inside a string
// never starts a comment. `#` counts only where it cannot be a directive or
// a heading: at a line start or after whitespace, followed by space, end, or
// `!` (shebang) -- never `#include`. Markdown prose only honors `<!-- -->`;
// its `#` and `*` are headings and bullets, not comments.
function commentStart(line: string, prose: boolean): number {
  if (!prose && /^\s*\*(?=\s|\/|$)/.test(line)) return line.search(/\*/);
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    const rest = line.slice(i);
    if (!prose && rest.startsWith("//")) return i;
    if (rest.startsWith("/*")) return i;
    if (rest.startsWith("<!--")) return i;
    if (!prose && c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      const next = line[i + 1] ?? "";
      if (next === "" || /\s/.test(next) || next === "!") return i;
    }
    if (!prose && rest.startsWith("--") && (i === 0 || /\s/.test(line[i - 1]!))) {
      const next = line[i + 2] ?? "";
      if (next === "" || /\s/.test(next)) return i;
    }
  }
  return -1;
}

function stripCommentMarkers(text: string): string {
  return text
    .replace(/-->\s*$/, "")
    .replace(/\*\/\s*$/, "")
    .replace(/^\s*<!--/, "")
    .replace(/^\s*\/\*/, "")
    .replace(/^\s*\/\//, "")
    .replace(/^\s*#/, "")
    .replace(/^\s*--/, "")
    .replace(/^\s*\*/, "")
    .replace(/\/+$/, "")
    .trim()
    .replace(/\s+/g, " ");
}

export function splitCodeComment(line: string, prose: boolean): { core: string; comment: string } {
  const at = commentStart(line, prose);
  if (at < 0) return { core: line.trim(), comment: "" };
  return {
    core: line.slice(0, at).trim(),
    comment: stripCommentMarkers(line.slice(at)),
  };
}

export function isProsePath(filePath?: string): boolean {
  return !!filePath && /\.(md|markdown|mdx)$/i.test(filePath);
}

export function shortText(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

// Every changed line carries a comment and the code around it is unchanged:
// pure comment lines (empty cores) or trailing-comment tweaks whose cores
// match as a multiset. Returns the excerpt, or null when code moved too.
export function describeCommentChange(added: string[], removed: string[], prose: boolean): string | null {
  const addedSplit = added.map((line) => splitCodeComment(line, prose));
  const removedSplit = removed.map((line) => splitCodeComment(line, prose));
  const all = [...addedSplit, ...removedSplit];
  if (all.length === 0 || all.some((part) => !part.comment)) return null;
  const coresEqual =
    addedSplit
      .map((part) => part.core)
      .sort()
      .join("\0") ===
    removedSplit
      .map((part) => part.core)
      .sort()
      .join("\0");
  if (!coresEqual) return null;
  const before = shortText(removedSplit.map((part) => part.comment).join(" / "));
  const after = shortText(addedSplit.map((part) => part.comment).join(" / "));
  if (before && after) return `${before} → ${after}`;
  return after ? `+${after}` : `-${before}`;
}
