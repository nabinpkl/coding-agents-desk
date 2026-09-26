// What an edit did, as one short detail line under the row's own header.
// The header keeps naming the file; this names the change: which functions
// it added, updated, or removed, plus the line counts. Pure and local: both
// harnesses already carry old and new text on the block, so no fetch and no
// model. Indentation-only churn is invisible by construction, since blank and
// whitespace-only lines never enter the diff. Comment-only edits read as
// comments with an excerpt, since no code moved.
import { describeCommentChange, isProsePath, shortText, splitCodeComment } from "@/features/activity-feed/blocks/diff/describeEditComments";

const FUNCTION_PATTERNS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:async\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[{:]/,
  /^\s*def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*fn\s+([A-Za-z_]\w*)/,
];

function functionNames(lines: string[]): string[] {
  const names: string[] = [];
  for (const line of lines) {
    for (const pattern of FUNCTION_PATTERNS) {
      const match = line.match(pattern);
      if (match?.[1] && !names.includes(match[1])) names.push(match[1]);
    }
  }
  return names;
}

// Multiset line diff: added holds lines new has more of, removed the reverse.
// Counting occurrences rather than positions keeps repeated lines honest.
// Indices ride along so changed lines can be placed inside their scope.
interface PlacedLine {
  line: string;
  index: number;
}

function diffLines(oldText: string, newText: string): { added: PlacedLine[]; removed: PlacedLine[] } {
  const oldCounts = new Map<string, number>();
  for (const line of oldText.split("\n")) {
    if (!line.trim()) continue;
    oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  }
  const added: PlacedLine[] = [];
  newText.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else added.push({ line, index });
  });
  const newCounts = new Map<string, number>();
  for (const line of newText.split("\n")) {
    if (!line.trim()) continue;
    newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  }
  const removed: PlacedLine[] = [];
  oldText.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    const left = newCounts.get(line) ?? 0;
    if (left > 0) newCounts.set(line, left - 1);
    else removed.push({ line, index });
  });
  return { added, removed };
}

function nameList(names: string[]): string {
  const shown = names.slice(0, 2).map((name) => `${name}()`);
  return names.length > 2 ? `${shown.join(", ")} +${names.length - 2} more` : shown.join(", ");
}

// Call expressions on changed lines: `stream.dispose()`, `serveWrite()`.
// Comment text strips first so `// call foo() on retry` never poses as a
// call, then strings, for the same reason. Control keywords and bare
// language operators are not calls.
const CALL_EXCLUDE = new Set([
  "if", "for", "while", "switch", "catch", "with", "function", "return",
  "typeof", "else", "do", "new", "await", "yield", "delete", "void",
  "require", "import",
]);

function shortModule(mod: string): string {
  const clean = mod.replace(/^\.\//, "./");
  return clean.length > 30 ? `…${clean.slice(-29)}` : clean;
}

interface ImportMove {
  names: string[];
  mod: string | null;
}

// Import statements on changed lines, per side. TypeScript, require,
// Python, and single-line Go; grouped blocks are rare in diffs and fall
// through to counts rather than half-parse.
function importMoves(lines: string[]): ImportMove[] {
  const moves: ImportMove[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    let match = line.match(/^import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/);
    if (match) {
      const names = match[1]!
        .split(",")
        .map((part) => part.replace(/^\*\s*as\s+/, "").replace(/\s+as\s+.*$/, "").replace(/[{}]/g, "").trim())
        .filter(Boolean);
      moves.push({ names, mod: match[2] ?? null });
      continue;
    }
    match = line.match(/^import\s+['"]([^'"]+)['"]/);
    if (match) {
      moves.push({ names: [], mod: match[1] ?? null });
      continue;
    }
    match = line.match(/^(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
    if (match) {
      moves.push({ names: match[1] ? [match[1]] : [], mod: match[2] ?? null });
      continue;
    }
    match = line.match(/^from\s+(\S+)\s+import\s+(.+)/);
    if (match) {
      const names = (match[2] ?? "").split(",").map((part) => part.replace(/\s+as\s+.*$/, "").replace(/[()]/g, "").trim()).filter(Boolean);
      moves.push({ names, mod: match[1] ?? null });
      continue;
    }
    match = line.match(/^import\s+(?:(\w+)\s+)?["]([^"]+)["]/);
    if (match) {
      moves.push({ names: match[1] ? [match[1]] : [], mod: match[2] ?? null });
      continue;
    }
    match = line.match(/^import\s+(.+)/);
    if (match && !match[1]?.startsWith("(")) {
      const names = (match[1] ?? "").split(",").map((part) => part.trim()).filter(Boolean);
      moves.push({ names, mod: null });
      continue;
    }
  }
  return moves;
}

function importLabel(moves: ImportMove[], verb: "imports" | "drops"): string | null {
  if (moves.length === 0) return null;
  const names = [...new Set(moves.flatMap((move) => move.names))].slice(0, 3);
  const mods = [...new Set(moves.map((move) => move.mod).filter((mod): mod is string => mod !== null))];
  const mod = mods.length === 1 && mods[0] ? ` from ${shortModule(mods[0])}` : "";
  if (names.length > 0) return `${verb} ${names.join(", ")}${mod}`;
  return mod ? `${verb}${mod}` : null;
}
function sameImport(a: ImportMove, b: ImportMove): boolean {
  return a.mod === b.mod && a.names.join(",") === b.names.join(",");
}

function callNames(lines: string[], prose: boolean): string[] {
  const names: string[] = [];
  const pattern = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
  for (const line of lines) {
    const { core } = splitCodeComment(line, prose);
    if (!core) continue;
    const code = core.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, `'""'`);
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      const full = match[1] ?? "";
      const head = full.split(".")[0] ?? "";
      if (full && !CALL_EXCLUDE.has(head) && !names.includes(full)) names.push(full);
    }
  }
  return names;
}

// Same callee, different arguments: `f(a)` → `f(a, b)`. The calls tier
// cancels a name present on both sides, so an argument-only change would
// fall to bare counts with nothing naming it. Comma parts split
// quote-aware; a reorder alone is not a change.
function inString(line: string, upto: number): boolean {
  let quote: string | null = null;
  for (let i = 0; i < upto && i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
  }
  return quote !== null;
}

function matchParen(line: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== null) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < args.length; i++) {
    const c = args[i]!;
    if (quote !== null) {
      current += c;
      if (c === "\\" && i + 1 < args.length) current += args[++i]!;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function updatedCallLabels(added: string[], removed: string[], prose: boolean): string[] {
  const collect = (lines: string[]): Map<string, string[]> => {
    const byName = new Map<string, string[]>();
    const head = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
    for (const line of lines) {
      const { core } = splitCodeComment(line, prose);
      if (!core) continue;
      let m: RegExpExecArray | null;
      head.lastIndex = 0;
      while ((m = head.exec(core)) !== null) {
        const name = m[1]!;
        if (inString(core, m.index)) continue;
        if (CALL_EXCLUDE.has(name.split(".")[0]!)) continue;
        const open = m.index + m[0].length - 1;
        const close = matchParen(core, open);
        if (close < 0) continue;
        byName.set(name, [...(byName.get(name) ?? []), ...splitArgs(core.slice(open + 1, close))]);
      }
    }
    return byName;
  };
  const addedBy = collect(added);
  const removedBy = collect(removed);
  const labels: string[] = [];
  for (const [name, aParts] of addedBy) {
    const rParts = removedBy.get(name);
    if (!rParts) continue;
    if ([...aParts].sort().join("\0") === [...rParts].sort().join("\0")) continue;
    const aSet = new Set(aParts);
    const rSet = new Set(rParts);
    const fresh = shortText(aParts.filter((part) => !rSet.has(part)).join(" / "));
    const gone = shortText(rParts.filter((part) => !aSet.has(part)).join(" / "));
    const change = fresh && gone ? `${gone} → ${fresh}` : fresh ? `+${fresh}` : `-${gone}`;
    labels.push(`updates ${name}(): ${change}`);
  }
  return labels.slice(0, 2);
}

// Enclosing function per line, by brace depth. A definition owns the lines
// after it until depth falls back to its own. Braces inside strings skew
// it; misattribution then degrades to bare counts, never to a wrong name
// presented as fact -- callers only use a scope every changed line agrees on.
// File-level declarations ride the same stack: an interface, a type alias or
// a top-level const owns the lines below it the way a function does, so an
// excerpt that opens with one still attributes. The const pattern anchors at
// line start on purpose: an indented `const` inside a function body would
// shadow the function for every line after it at the same depth.
const SCOPE_PATTERNS = [
  /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*export\s+(?:async\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[{:]/,
  /^\s*def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*fn\s+([A-Za-z_]\w*)/,
  /^(?:export\s+)?(?:default\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
  /^(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
];

function scopesFor(text: string): (string | null)[] {
  const lines = text.split("\n");
  const scopes: (string | null)[] = [];
  const stack: { name: string; depth: number }[] = [];
  let depth = 0;
  for (const line of lines) {
    if (!line.trim()) {
      scopes.push(stack.length > 0 ? stack[stack.length - 1]!.name : null);
      continue;
    }
    for (const pattern of SCOPE_PATTERNS) {
      const match = line.match(pattern);
      if (match?.[1]) {
        stack.push({ name: match[1], depth });
        break;
      }
    }
    scopes.push(stack.length > 0 ? stack[stack.length - 1]!.name : null);
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) stack.pop();
  }
  return scopes;
}

// The single scope every changed line agrees on, or null. Disagreement --
// or any unscoped line -- degrades to bare counts rather than a wrong name.
function agreedScope(
  oldText: string,
  newText: string,
  added: PlacedLine[],
  removed: PlacedLine[],
): string | null {
  const oldScopes = scopesFor(oldText);
  const newScopes = scopesFor(newText);
  const names = new Set<string>();
  for (const { index } of removed) names.add(oldScopes[index] ?? "");
  for (const { index } of added) names.add(newScopes[index] ?? "");
  names.delete("");
  if (names.size !== 1) return null;
  return [...names][0] ?? null;
}

function compactFragment(line: string): string {
  const clean = line.trim().replace(/\s+/g, " ");
  return clean.length > 50 ? `${clean.slice(0, 50)}…` : clean;
}

export function describeEditChange(oldText: string, newText: string, filePath?: string): string | null {
  const { added, removed } = diffLines(oldText, newText);
  if (added.length === 0 && removed.length === 0) return null;
  const prose = isProsePath(filePath);
  const addedLines = added.map((part) => part.line);
  const removedLines = removed.map((part) => part.line);
  const addedFns = functionNames(addedLines);
  const removedFns = functionNames(removedLines);
  // Added and removed signature names, never "updated": a signature in both
  // lists changed body, not identity, and the scope below says where.
  const fresh = addedFns.filter((name) => !removedFns.includes(name));
  const gone = removedFns.filter((name) => !addedFns.includes(name));
  const parts: string[] = [];
  if (fresh.length > 0) parts.push(`adds ${nameList(fresh)}`);
  if (gone.length > 0) parts.push(`removes ${nameList(gone)}`);
  const counts = `+${added.length}/-${removed.length}`;
  if (parts.length > 0) {
    parts.push(counts);
    return parts.join(", ");
  }
  // No signature moved: name the imports first, then the calls. Import
  // lines carry no parens for the call tier and no keywords for the scope,
  // so without this they read as bare counts.
  const addedImports = importMoves(addedLines);
  const removedImports = importMoves(removedLines);
  const importsIn = importLabel(
    addedImports.filter((move) => !removedImports.some((other) => sameImport(move, other))),
    "imports",
  );
  const importsOut = importLabel(
    removedImports.filter((move) => !addedImports.some((other) => sameImport(move, other))),
    "drops",
  );
  if (importsIn) parts.push(importsIn);
  if (importsOut) parts.push(importsOut);
  if (parts.length > 0) {
    parts.push(counts);
    return parts.join(", ");
  }
  // Comment-only edits outrank calls and scope: no code moved, so the call
  // tier would either misread `// foo()` as a call or the row would fall to
  // bare counts with nothing naming the change.
  const commentExcerpt = describeCommentChange(addedLines, removedLines, prose);
  if (commentExcerpt) {
    const scope = agreedScope(oldText, newText, added, removed);
    const head = scope ? `comment in ${scope}()` : "comment";
    const tiny = added.length <= 2 && removed.length <= 2;
    return tiny ? `${head}: ${commentExcerpt}` : `${head}: ${commentExcerpt}, ${counts}`;
  }
  const addedCalls = callNames(addedLines, prose);
  const removedCalls = callNames(removedLines, prose);
  const called = addedCalls.filter((name) => !removedCalls.includes(name));
  const dropped = removedCalls.filter((name) => !addedCalls.includes(name));
  if (called.length > 0) parts.push(`calls ${nameList(called)}`);
  if (dropped.length > 0) parts.push(`drops ${nameList(dropped)}`);
  for (const label of updatedCallLabels(addedLines, removedLines, prose)) parts.push(label);
  if (parts.length > 0) {
    parts.push(counts);
    return parts.join(", ");
  }
  const scope = agreedScope(oldText, newText, added, removed);
  if (scope) {
    // Tiny diffs show the fragments; large ones flag the size. Fifty added
    // lines is the major-addition line: big enough that the row should say so.
    if (added.length <= 2 && removed.length <= 2) {
      const before = removedLines.map(compactFragment).join(" / ");
      const after = addedLines.map(compactFragment).join(" / ");
      const change = before && after ? `${before} → ${after}` : after ? `+${after}` : `-${before}`;
      return `${scope}(): ${change}`;
    }
    if (added.length >= 50) return `major addition to ${scope}(), ${counts}`;
    if (removed.length >= 50) return `major removal from ${scope}(), ${counts}`;
    return `${scope}(), ${counts}`;
  }
  // No tier above fired and no scope agrees: a tiny diff still names itself.
  // A one-line value swap (`top-3` → `top-0`), a reworded string, a reshaped
  // type with no parens in it -- the fragment IS the label, and it fits the
  // row the bare counts never explained. Same two-line bound as the scoped
  // tiny diffs above, for the same reason. Anything larger stays on counts:
  // a fragment of a big diff names one corner of it, which would read as the
  // whole change.
  if (added.length <= 2 && removed.length <= 2) {
    const before = removedLines.map(compactFragment).join(" / ");
    const after = addedLines.map(compactFragment).join(" / ");
    if (before && after) return `${before} → ${after}`;
    if (after) return `+${after}`;
    return `-${before}`;
  }
  return counts;
}
