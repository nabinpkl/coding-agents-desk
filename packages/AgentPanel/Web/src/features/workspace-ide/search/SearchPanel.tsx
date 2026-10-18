// The Search section: a query, three toggles, include and exclude globs, and the matching lines
// grouped by file. VS Code's search view, without Replace.

import { forwardRef, useState } from "react";
import { ChevronDown, ChevronRight, Ellipsis } from "lucide-react";
import { FileIcon } from "@/features/workspace-ide/sidebar/FileIcon";
import { Highlighted } from "@/features/workspace-ide/search/Highlighted";
import type { ContentSearch } from "@/features/workspace-ide/search/useContentSearch";

const FIELD = "min-w-0 flex-1 bg-transparent px-2 py-1 text-sm outline-none placeholder:text-muted-foreground";
const BOX =
  "flex items-center rounded-md border border-border bg-background focus-within:ring-2" + " focus-within:ring-primary";
const TOGGLE =
  "grid h-6 min-w-6 place-items-center rounded px-1 font-mono text-[11px] outline-none" +
  " transition-colors focus-visible:ring-2 focus-visible:ring-primary" +
  " aria-pressed:bg-primary/15 aria-pressed:text-foreground text-muted-foreground hover:bg-muted/60";

const OPTIONS = [
  { option: "matchCase", glyph: "Aa", label: "Match case" },
  { option: "wholeWord", glyph: "ab", label: "Match whole word" },
  { option: "regex", glyph: ".*", label: "Use regular expression" },
] as const;

export const SearchPanel = forwardRef<
  HTMLInputElement,
  {
    search: ContentSearch;
    /** Opens one result: the file in the preview tab, at the line. */
    onOpen: (path: string, line: number, start: number, end: number) => void;
  }
>(function SearchPanel({ search, onOpen }, queryField) {
  const [globsShown, setGlobsShown] = useState(search.include !== "" || search.exclude !== "");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const { result } = search;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid shrink-0 gap-1.5 px-1.5 pb-2 pt-1">
        <div className={BOX}>
          <input
            ref={queryField}
            id="workspace-search-query"
            type="search"
            aria-label="Search in files"
            placeholder="Search"
            value={search.query}
            onChange={(event) => search.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") search.runNow();
            }}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={FIELD}
          />
          <div className="flex shrink-0 gap-0.5 pr-1">
            {OPTIONS.map(({ option, glyph, label }) => (
              <button
                key={option}
                type="button"
                aria-label={label}
                title={label}
                aria-pressed={search.options[option]}
                onClick={() => search.toggle(option)}
                className={TOGGLE}
              >
                {glyph}
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            aria-label="Toggle search details"
            aria-expanded={globsShown}
            title="Files to include and exclude"
            onClick={() => setGlobsShown((shown) => !shown)}
            className={TOGGLE}
          >
            <Ellipsis className="size-3.5" />
          </button>
        </div>
        {globsShown ? (
          <>
            <label className="grid gap-0.5 text-[11px] text-muted-foreground">
              Files to include
              <input
                id="workspace-search-include"
                value={search.include}
                onChange={(event) => search.setInclude(event.target.value)}
                placeholder="e.g. *.ts, src/**"
                spellCheck={false}
                className={`${BOX} ${FIELD} text-foreground`}
              />
            </label>
            <label className="grid gap-0.5 text-[11px] text-muted-foreground">
              Files to exclude
              <input
                id="workspace-search-exclude"
                value={search.exclude}
                onChange={(event) => search.setExclude(event.target.value)}
                placeholder="e.g. *.test.ts, dist"
                spellCheck={false}
                className={`${BOX} ${FIELD} text-foreground`}
              />
            </label>
          </>
        ) : null}
      </div>

      <div role="status" className="shrink-0 px-2.5 pb-1 text-[11px] text-muted-foreground">
        {search.error ? (
          <span className="text-destructive">{search.error}</span>
        ) : search.searching && !result ? (
          "Searching…"
        ) : result ? (
          summary(result.matchCount, result.files.length, result.truncated)
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1 pb-4">
        {result?.files.map((file) => {
          const closed = collapsed.has(file.path);
          const Chevron = closed ? ChevronRight : ChevronDown;
          const slash = file.path.lastIndexOf("/");
          const name = file.path.slice(slash + 1);
          return (
            <section key={file.path}>
              <button
                type="button"
                aria-expanded={!closed}
                aria-label={`${closed ? "Expand" : "Collapse"} ${file.path}`}
                title={file.path}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (!next.delete(file.path)) next.add(file.path);
                    return next;
                  })
                }
                className="sticky top-0 z-10 flex w-full items-center gap-1.5 rounded bg-background
                  px-1 py-1 text-left outline-none hover:bg-muted/60 focus-visible:ring-2
                  focus-visible:ring-primary focus-visible:ring-inset"
              >
                <Chevron aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                <FileIcon name={name} />
                <span className="min-w-0 shrink overflow-hidden text-ellipsis whitespace-nowrap">{name}</span>
                <span
                  className="min-w-0 flex-1 basis-0 overflow-hidden text-ellipsis whitespace-nowrap
                    text-[11px] text-muted-foreground"
                >
                  {slash > 0 ? file.path.slice(0, slash) : ""}
                </span>
                <span
                  className="shrink-0 rounded-full bg-muted px-1.5 py-px font-mono text-[10px]
                    text-muted-foreground"
                >
                  {file.matches.length}
                </span>
              </button>
              {closed ? null : (
                <ul aria-label={`Matches in ${file.path}`} className="m-0 list-none p-0">
                  {file.matches.map((match) => (
                    <li key={match.line}>
                      <button
                        type="button"
                        aria-label={`Open ${file.path} at line ${match.line}`}
                        onClick={() => {
                          const [start, end] = match.ranges[0] ?? [0, 0];
                          onOpen(file.path, match.line, start + match.previewOffset, end + match.previewOffset);
                        }}
                        className="flex w-full items-baseline gap-2 rounded py-0.5 pl-7 pr-1.5
                            text-left outline-none hover:bg-muted/60 focus-visible:ring-2
                            focus-visible:ring-primary focus-visible:ring-inset active:bg-muted"
                      >
                        <span
                          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre
                            font-mono text-xs"
                        >
                          <Highlighted text={match.preview.trimEnd()} ranges={match.ranges} />
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{match.line}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
});

function summary(matches: number, files: number, truncated: boolean): string {
  if (matches === 0) return "No results.";
  const results = `${matches.toLocaleString()} result${matches === 1 ? "" : "s"}`;
  const inFiles = `in ${files.toLocaleString()} file${files === 1 ? "" : "s"}`;
  return truncated ? `The first ${results} ${inFiles}. Narrow the search to see the rest.` : `${results} ${inFiles}`;
}
