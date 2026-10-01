// Quick open: type part of a file's name, pick it, it opens. Double Shift, Cmd+P, or the toolbar.
//
// The file list is fetched once per opening and matched here on every keystroke: the sidecar
// answers the list in tens of milliseconds, and a round trip per character would be the slow half.
// `path:42` opens at line 42, as in VS Code.

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileSearch, Loader2 } from "lucide-react";
import { FileIcon } from "@/features/workspace-ide/sidebar/FileIcon";
import { fuzzyFilter, type FuzzyMatch } from "@/features/workspace-ide/search/fuzzyMatch";
import { Highlighted, positionRanges } from "@/features/workspace-ide/search/Highlighted";
import { WorkspaceRequestError, type WorkspaceIdeClient } from "@/features/workspace-ide/workspaceIdeClient";

/** Rows drawn at once. A reader who has not found it in fifty types another character. */
export const QUICK_OPEN_ROWS = 50;

/** Split `src/app.ts:42` into the path query and the line. A bare trailing `:` is still typing. */
export function parseQuickOpenQuery(value: string): { query: string; line: number | null } {
  const match = /^(.*?):(\d+)$/.exec(value.trim());
  if (!match) return { query: value.trim().replace(/:$/, ""), line: null };
  return { query: match[1]!, line: Number.parseInt(match[2]!, 10) };
}

export function QuickOpen({
  client,
  workspaceId,
  openPaths,
  onOpen,
  onClose,
}: {
  client: WorkspaceIdeClient;
  workspaceId: string;
  /** The tabs already open, offered first on an empty query and ranked up on a typed one. */
  openPaths: readonly string[];
  onOpen: (path: string, line: number | null) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLUListElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client.files(workspaceId, controller.signal)
      .then((answer) => {
        setFiles(answer.files);
        setTruncated(answer.truncated);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof WorkspaceRequestError ? cause.message : "The file list could not be loaded.");
      });
    return () => controller.abort();
  }, [client, workspaceId]);

  const { query: typed, line } = parseQuickOpenQuery(value);
  // Deferred, so the field takes each character at once and the list catches up. Scoring is the
  // slow half: measured 2026-09-30, "agents" over an 18,705-file folder is 13,546 candidates and
  // about 45ms on a Mac, several times that on a phone.
  const query = useDeferredValue(typed);
  const matches = useMemo((): FuzzyMatch[] => {
    const open = new Set(openPaths);
    if (query === "") {
      const rest = (files ?? []).filter((path) => !open.has(path));
      return [...openPaths, ...rest].slice(0, QUICK_OPEN_ROWS).map((path) => ({ path, score: 0, positions: [] }));
    }
    // Open tabs lead among comparable matches, the way VS Code puts recently opened files first.
    const pool = files ?? [...openPaths];
    return fuzzyFilter(pool, query, QUICK_OPEN_ROWS * 2)
      .map((match) => (open.has(match.path) ? { ...match, score: match.score + 10 } : match))
      .sort((left, right) => right.score - left.score)
      .slice(0, QUICK_OPEN_ROWS);
  }, [files, openPaths, query]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = (match: FuzzyMatch | undefined) => {
    if (!match) return;
    onOpen(match.path, line);
  };

  return createPortal(
    // The page behind it is dimmed but not blurred: the reader is choosing a file to go to, and
    // the one they are leaving is still worth seeing.
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/30 px-4 pt-[12vh]"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Go to file"
        className="flex h-fit max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border
          border-border bg-background shadow-xl"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3">
          <FileSearch aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input
            id="workspace-quick-open"
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="workspace-quick-open-results"
            aria-activedescendant={matches[selected] ? `workspace-quick-open-${selected}` : undefined}
            aria-label="File name"
            placeholder="Go to file, or file:line"
            value={value}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((index) => Math.min(index + 1, matches.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(matches[selected]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none
              placeholder:text-muted-foreground"
          />
          {files === null && !error
            ? <Loader2 aria-label="Loading files" className="size-4 shrink-0 animate-spin text-muted-foreground" />
            : null}
        </div>
        <ul
          ref={list}
          id="workspace-quick-open-results"
          role="listbox"
          aria-label="Files"
          className="m-0 min-h-0 list-none overflow-auto p-1"
        >
          {matches.map((match, index) => {
            const slash = match.path.lastIndexOf("/");
            const name = match.path.slice(slash + 1);
            const directory = slash > 0 ? match.path.slice(0, slash) : "";
            return (
              <li
                key={match.path}
                id={`workspace-quick-open-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === selected}
                onPointerMove={() => setSelected(index)}
                onClick={() => choose(match)}
                className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm
                  ${index === selected ? "bg-muted" : ""}`}
              >
                <FileIcon name={name} />
                <span className="shrink-0 whitespace-nowrap">
                  <Highlighted text={name} ranges={positionRanges(match.positions, slash + 1)} />
                </span>
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs
                  text-muted-foreground"
                >
                  <Highlighted
                    text={directory}
                    ranges={positionRanges(match.positions.filter((position) => position < slash))}
                  />
                </span>
              </li>
            );
          })}
        </ul>
        {error || truncated || (files !== null && matches.length === 0)
          ? (
            <p className="m-0 shrink-0 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
              {error
                ?? (matches.length === 0
                  ? "No file matches."
                  : "This workspace has more files than quick open lists; the rest are not offered.")}
            </p>
          )
          : null}
      </div>
    </div>,
    document.body,
  );
}
