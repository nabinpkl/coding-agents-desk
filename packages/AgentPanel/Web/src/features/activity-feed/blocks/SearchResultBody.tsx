"use client";

// Structured bodies for search tool results (Grep/Glob, either harness).
//
// A search result is a list, not prose: grep content mode emits `path:line: match`
// lines, glob and grep file modes emit bare paths. The generic result `pre` wraps
// either into one run of text, so a 23-file answer reads as a paragraph. Parsed
// here: content matches group by file under that file's own grammar, file lists
// draw one truncated path per row. Anything neither shape fits returns null and
// stays on the existing `pre` path -- an unknown output keeps its bytes rather
// than losing them to a parser that guessed.

import { CodeBlock } from "@/features/activity-feed/markdown/CodeBlock";

export type SearchResultBody =
  /** Content matches, grouped by file in first-appearance order. Each line keeps
   *  its `line:` prefix as a gutter marker; the `path:` prefix is redundant
   *  under the group header and is stripped. */
  | { kind: "matches"; groups: { path: string; lines: string[] }[] }
  /** Bare paths, with the tool's own count line as caption where it sent one. */
  | { kind: "files"; caption: string | null; paths: string[] };

/** `path:line: match`, where the path must look like a path: a bare `12:34: x`
 *  is a numbered list, and `10:30:45 x` a timestamp, so the segment before the
 *  first colon has to carry a `/` or a `.` to count. */
const MATCH_LINE = /^((?=[^:]*[/.])([^:\s][^:]*?)):(\d+):(.*)$/;
const COUNT_LINE = /^Found \d+ files?$/i;
const EMPTY_LINE = /^No files found/i;
/** A path has no whitespace and no colon; a line with either is prose, not a
 *  result row, and falls back to the `pre`. Paths with spaces cost a fallback
 *  rather than a misread list. */
const PATH_LINE = /^[^\s:]+$/;

function isSearchTool(tool: string): boolean {
  return tool === "Grep" || tool === "grep" || tool === "Glob" || tool === "glob";
}

export function parseSearchResult(tool: string | undefined, text: string): SearchResultBody | null {
  if (typeof tool !== "string" || !isSearchTool(tool)) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const lines = trimmed
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  if (lines.length === 0) return null;

  const matched = lines.flatMap((line) => {
    const parsed = MATCH_LINE.exec(line);
    return parsed ? [{ path: parsed[1]!, line: parsed[3]!, content: parsed[4]! }] : [];
  });
  // Content mode: at least half the lines are matches, so one stray `a:1: b`
  // line in prose does not regroup the paragraph around it.
  if (matched.length > 0 && matched.length * 2 >= lines.length) {
    const groups = new Map<string, string[]>();
    for (const { path, line, content } of matched) {
      const rows = groups.get(path) ?? [];
      rows.push(`${line}:${content}`);
      groups.set(path, rows);
    }
    return {
      kind: "matches",
      groups: [...groups].map(([path, groupLines]) => ({ path, lines: groupLines })),
    };
  }

  const [first, ...rest] = lines;
  if (first !== undefined && (COUNT_LINE.test(first.trim()) || EMPTY_LINE.test(first.trim()))) {
    return { kind: "files", caption: first.trim(), paths: rest.filter((line) => line.trim()) };
  }
  // A captionless file list: every line path-shaped, and at least one carrying
  // a `/` or `.` so a bare word never reads as a one-row list.
  if (lines.every((line) => PATH_LINE.test(line.trim())) && lines.some((line) => /[/.]/.test(line))) {
    return { kind: "files", caption: null, paths: lines.map((line) => line.trim()) };
  }
  return null;
}

export function SearchResultBody({ body }: { body: SearchResultBody }) {
  if (body.kind === "files") {
    return (
      <div className="space-y-[0.3em]" style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}>
        {body.caption ? <div className="text-[0.85em] text-muted-foreground">{body.caption}</div> : null}
        {body.paths.length > 0 ? (
          <div className="rounded-sm border border-border/50 bg-muted/30 px-2 py-1.5 font-mono text-foreground/80">
            {body.paths.map((path, index) => (
              <div key={`${path}-${index}`} className="truncate" title={path}>
                {path}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-[0.4em]" style={{ fontSize: "var(--agent-panel-fs-tile-other-text, 16px)" }}>
      {body.groups.map((group) => (
        <div key={group.path} className="space-y-[0.2em]">
          <div className="truncate font-mono text-[0.85em] text-muted-foreground" title={group.path}>
            {group.path.split("/").pop() ?? group.path}
          </div>
          <CodeBlock code={group.lines.join("\n")} lang={group.path} />
        </div>
      ))}
    </div>
  );
}
