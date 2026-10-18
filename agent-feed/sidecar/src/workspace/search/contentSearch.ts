// Text search inside a workspace's files: the IDE's Search section.
//
// Exact, never fuzzy. A fuzzy match over content would have to score every line there is, and
// measured 2026-09-30 on `~/projects` that is 2.6 million lines and 306MB per query. What stands
// in for it is two cheap rules: smart case, and several words matched in any order on one line.

import type { WorkspaceSearchFile, WorkspaceSearchMatch, WorkspaceSearchOptions } from "@agentdesk/agent-feed-wire";
import { MAXIMUM_SEARCHED_FILE_SIZE, relativePath, scopeArguments } from "@/workspace/search/searchScope";
import { runRipgrep, SearchFailure } from "@/workspace/search/ripgrep";

/** VS Code's `search.maxResults`: past this the answer says it is partial. */
export const MAXIMUM_MATCHES = 20_000;
/** Lines per file, so one enormous generated file cannot spend the whole budget. */
export const MAXIMUM_MATCHES_PER_FILE = 1_000;
/** A preview longer than this is cut to a window around its first hit. */
export const MAXIMUM_PREVIEW_CHARACTERS = 240;
const PREVIEW_LEAD = 40;
export const MAXIMUM_QUERY_CHARACTERS = 1_000;
export const MAXIMUM_GLOBS = 32;

type Range = [number, number];

/** How one query is carried out: what `rg` is asked, and what the answer is filtered through. */
interface Plan {
  args: string[];
  /** Ranges to highlight in a line `rg` matched, or null to drop the line. */
  filter: (line: string, submatches: Range[]) => Range[] | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn a query and its options into a plan.
 *
 * A literal query of several words asks `rg` for the longest word -- the rarest, so the fewest
 * lines to check -- and keeps only the lines holding every other word as well, highlighting all of
 * them. A `"quoted"` query, a regex, or a single word goes to `rg` whole.
 */
export function planSearch(query: string, options: WorkspaceSearchOptions): Plan {
  // Smart case, decided here rather than with `rg -S` so the words checked below agree with it.
  const insensitive = !options.matchCase && query === query.toLowerCase();
  const base = [
    ...scopeArguments(),
    "--json",
    `--max-filesize=${MAXIMUM_SEARCHED_FILE_SIZE}`,
    `--max-count=${MAXIMUM_MATCHES_PER_FILE}`,
    insensitive ? "--ignore-case" : "--case-sensitive",
    ...options.include.map((glob) => `--glob=${glob}`),
    ...options.exclude.map((glob) => `--glob=!${glob.replace(/^!/, "")}`),
  ];
  if (options.wholeWord) base.push("--word-regexp");
  const whole: Plan["filter"] = (_line, submatches) => submatches;

  if (options.regex) return { args: [...base, "--", query, "."], filter: whole };

  const quoted = /^"(.+)"$/.exec(query.trim());
  const words = quoted ? [quoted[1]!] : query.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) {
    return { args: [...base, "--fixed-strings", "--", words[0] ?? query, "."], filter: whole };
  }
  const anchor = words.reduce((longest, word) => (word.length > longest.length ? word : longest));
  const boundary = options.wholeWord ? "\\b" : "";
  const patterns = words.map(
    (word) => new RegExp(`${boundary}${escapeRegExp(word)}${boundary}`, insensitive ? "gi" : "g"),
  );
  return {
    args: [...base, "--fixed-strings", "--", anchor, "."],
    filter: (line) => {
      const ranges: Range[] = [];
      for (const pattern of patterns) {
        const found = [...line.matchAll(pattern)].map((hit): Range => [hit.index, hit.index + hit[0].length]);
        if (found.length === 0) return null;
        ranges.push(...found);
      }
      return ranges.sort((left, right) => left[0] - right[0]);
    },
  };
}

/**
 * `rg`'s submatch offsets are bytes into the UTF-8 line; the panel indexes JavaScript strings.
 * Converted by measuring each prefix, which is exact for any line and cheap for one that matched.
 */
function characterRanges(line: string, submatches: Array<{ start: number; end: number }>): Range[] {
  const bytes = Buffer.from(line, "utf8");
  const at = (offset: number) => bytes.subarray(0, offset).toString("utf8").length;
  return submatches.map(({ start, end }): Range => [at(start), at(end)]);
}

/** A long line, cut to a window that starts a little before its first hit. */
export function trimPreview(
  line: string,
  ranges: Range[],
): { preview: string; ranges: Range[]; previewOffset: number } {
  if (line.length <= MAXIMUM_PREVIEW_CHARACTERS) return { preview: line, ranges, previewOffset: 0 };
  const first = ranges[0]?.[0] ?? 0;
  const start = Math.max(0, Math.min(first - PREVIEW_LEAD, line.length - MAXIMUM_PREVIEW_CHARACTERS));
  const end = start + MAXIMUM_PREVIEW_CHARACTERS;
  const lead = start > 0 ? "…" : "";
  const shift = lead.length - start;
  const kept = ranges
    .filter(([from, to]) => to > start && from < end)
    .map(([from, to]): Range => [Math.max(from, start) + shift, Math.min(to, end) + shift]);
  return {
    preview: `${lead}${line.slice(start, end)}${end < line.length ? "…" : ""}`,
    ranges: kept,
    previewOffset: -shift,
  };
}

interface RipgrepMatch {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start: number; end: number }>;
  };
}

export async function searchContent(
  binary: string | null,
  root: string,
  query: string,
  options: WorkspaceSearchOptions,
  signal?: AbortSignal,
): Promise<{ files: WorkspaceSearchFile[]; matchCount: number; truncated: boolean }> {
  if (query.trim() === "") return { files: [], matchCount: 0, truncated: false };
  if (query.length > MAXIMUM_QUERY_CHARACTERS) {
    throw new SearchFailure("invalidQuery", `A query is limited to ${MAXIMUM_QUERY_CHARACTERS} characters.`);
  }
  if (options.include.length + options.exclude.length > MAXIMUM_GLOBS) {
    throw new SearchFailure("invalidQuery", `At most ${MAXIMUM_GLOBS} include and exclude globs.`);
  }
  const plan = planSearch(query, options);
  const byPath = new Map<string, WorkspaceSearchMatch[]>();
  let matchCount = 0;
  let truncated = false;

  await runRipgrep(
    binary,
    plan.args,
    root,
    (record) => {
      let event: RipgrepMatch;
      try {
        event = JSON.parse(record) as RipgrepMatch;
      } catch {
        return true;
      }
      if (event.type !== "match") return true;
      const path = event.data?.path?.text;
      const text = event.data?.lines?.text;
      const line = event.data?.line_number;
      // A path or line that is not UTF-8 arrives as base64 `bytes` instead; it is skipped, because
      // the viewer could not open that file as text either.
      if (path === undefined || text === undefined || line === undefined) return true;
      const content = text.replace(/\r?\n$/, "");
      const ranges = plan.filter(content, characterRanges(content, event.data?.submatches ?? []));
      if (ranges === null) return true;
      if (matchCount >= MAXIMUM_MATCHES) {
        truncated = true;
        return false;
      }
      matchCount += 1;
      const relative = relativePath(path);
      const matches = byPath.get(relative) ?? [];
      matches.push({ line, ...trimPreview(content, ranges) });
      byPath.set(relative, matches);
      return true;
    },
    { separator: "\n", signal },
  );

  const files = [...byPath.entries()]
    .map(([path, matches]) => ({ path, matches: matches.sort((left, right) => left.line - right.line) }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return { files, matchCount, truncated };
}
