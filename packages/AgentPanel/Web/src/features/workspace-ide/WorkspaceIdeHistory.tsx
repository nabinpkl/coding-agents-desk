// What is already committed, as a panel that rises from the status bar.
//
// The IDE had no way to look backwards at all: the sidebar answers what is changed NOW, and the
// editor answers what a file says now. This answers the other question a reader of a repository
// asks constantly -- what landed, and what did it do -- without leaving the surface for a terminal.
//
// Three levels, each fetched only when it is asked for. The log is cheap and comes with the panel;
// a commit's file list costs two `git show` passes and waits for the commit to be expanded; a
// patch costs one more and waits for the file to be clicked. A panel that fetched every patch of
// fifty commits up front would be megabytes to answer one question about one line.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, GitCommitHorizontal, Loader2, X } from "lucide-react";
import type {
  WorkspaceCommit,
  WorkspaceCommitDiff,
  WorkspaceCommitFile,
} from "@agentdesk/agent-feed-wire";
import { FileIcon } from "@/features/workspace-ide/sidebar/FileIcon";
import { gitStatusTone, TONE_BADGE } from "@/features/workspace-ide/sidebar/gitTones";
import { parsePatch, type PatchLine } from "@/features/workspace-ide/gitPatch";
import type { WorkspaceIdeClient } from "@/features/workspace-ide/workspaceIdeClient";

/** How many commits arrive at a time, and how many each "Show more" adds. */
const PAGE = 50;

const ROW = "flex w-full items-center gap-2 px-2 text-left outline-none transition-colors"
  + " hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset";

/**
 * How old a commit is, in the unit a reader would say it in.
 *
 * Relative up to a week, then the date. "13w ago" is arithmetic the reader has to undo to know
 * whether it was before or after something else they remember; "Jun 4" is the thing itself.
 */
function age(committedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round(now / 1000 - committedAt));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(committedAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function WorkspaceIdeHistory({
  id,
  client,
  workspaceId,
  onClose,
}: {
  /** The popup's element id, so the control that opened it can point at it with `aria-controls`. */
  id: string;
  client: WorkspaceIdeClient;
  workspaceId: string;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [commits, setCommits] = useState<WorkspaceCommit[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // One commit open at a time, and one file inside it. The popup is about a phone-screen tall, and
  // two expanded commits mean the reader scrolls away from the one they were reading to reach the
  // rest of it. An accordion is the version of this that fits.
  const [openHash, setOpenHash] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  // Cached by what identifies them, so collapsing and expanding the same commit is free and a
  // second look at a diff does not re-read the repository.
  const [files, setFiles] = useState<Record<string, WorkspaceCommitFile[]>>({});
  const [diffs, setDiffs] = useState<Record<string, WorkspaceCommitDiff>>({});

  // The panel takes focus when it opens: it is the thing the reader just asked for, and Escape has
  // to reach it from somewhere. The control that opened it takes focus back on close.
  useEffect(() => panel.current?.focus(), []);

  useEffect(() => {
    let live = true;
    client.commits(workspaceId, limit)
      .then((answer) => {
        if (live) setCommits(answer.commits);
      })
      .catch((cause: unknown) => {
        if (live) setFailure(`Could not read the history: ${message(cause)}`);
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, limit]);

  useEffect(() => {
    if (openHash === null || files[openHash]) return;
    let live = true;
    client.commit(workspaceId, openHash)
      .then((answer) => {
        if (live) setFiles((current) => ({ ...current, [openHash]: answer.detail.files }));
      })
      .catch((cause: unknown) => {
        if (live) setFailure(`Could not read that commit: ${message(cause)}`);
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, openHash, files]);

  const diffKey = openHash !== null && openPath !== null ? `${openHash}:${openPath}` : null;
  useEffect(() => {
    if (diffKey === null || openHash === null || openPath === null || diffs[diffKey]) return;
    let live = true;
    client.commitDiff(workspaceId, openHash, openPath)
      .then((answer) => {
        if (live) setDiffs((current) => ({ ...current, [diffKey]: answer.diff }));
      })
      .catch((cause: unknown) => {
        if (live) setFailure(`Could not read that diff: ${message(cause)}`);
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, diffKey, openHash, openPath, diffs]);

  const toggleCommit = useCallback((hash: string) => {
    setOpenPath(null);
    setOpenHash((current) => (current === hash ? null : hash));
  }, []);

  const now = Date.now();
  return (
    <div
      id={id}
      ref={panel}
      role="dialog"
      aria-label="Commit history"
      tabIndex={-1}
      // Attached to the bar rather than floating over it: square along the bottom, bordered and
      // rounded on the three sides that are not touching, with the shadow thrown upward. Anchored
      // to the bar's left edge, which is where the control that opens it sits, and full width until
      // there is room for more.
      className="absolute bottom-full left-0 z-30 flex max-h-[min(60vh,460px)] w-full
        max-w-[680px] flex-col overflow-hidden rounded-t-lg border border-b-0 border-border
        bg-background shadow-[0_-10px_30px_rgb(0_0_0/0.18)] outline-none"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5">
        <GitCommitHorizontal aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="m-0 flex-1 text-sm font-medium">History</h2>
        <button
          type="button"
          aria-label="Close history"
          onClick={onClose}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground
            outline-none transition-colors hover:bg-muted hover:text-foreground
            focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
        >
          <X className="size-4" />
        </button>
      </header>

      {failure
        ? (
          <p role="status" className="m-0 shrink-0 border-b border-border bg-destructive/10 px-2.5
            py-1.5 text-xs text-destructive"
          >
            {failure}
          </p>
        )
        : null}

      <div className="min-h-0 flex-1 overflow-auto">
        {commits === null
          ? <Waiting label="Reading the history…" />
          : commits.length === 0
            ? (
              // A directory git does not track and a repository with no commits land here alike:
              // `git log` answers nothing for both, and neither is a failure to report.
              <p className="m-0 px-4 py-8 text-center text-sm text-muted-foreground">
                No commits to show. This workspace is either not a git repository or has nothing
                committed yet.
              </p>
            )
            : (
              <ul className="m-0 list-none p-0">
                {commits.map((commit) => (
                  <Commit
                    key={commit.hash}
                    commit={commit}
                    now={now}
                    expanded={commit.hash === openHash}
                    files={files[commit.hash]}
                    openPath={openPath}
                    diffs={diffs}
                    onToggle={() => toggleCommit(commit.hash)}
                    onSelectPath={(path) => setOpenPath((current) => (current === path ? null : path))}
                  />
                ))}
              </ul>
            )}
        {commits !== null && commits.length >= limit
          ? (
            <button
              type="button"
              onClick={() => setLimit((current) => current + PAGE)}
              className="w-full px-2 py-2 text-center text-xs text-muted-foreground outline-none
                transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2
                focus-visible:ring-primary focus-visible:ring-inset"
            >
              Show {PAGE} more
            </button>
          )
          : null}
      </div>
    </div>
  );
}

function Waiting({ label }: { label: string }) {
  return (
    <p className="m-0 flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
      <Loader2 aria-hidden className="size-4 animate-spin" />
      {label}
    </p>
  );
}

function Commit({
  commit,
  now,
  expanded,
  files,
  openPath,
  diffs,
  onToggle,
  onSelectPath,
}: {
  commit: WorkspaceCommit;
  now: number;
  expanded: boolean;
  files: WorkspaceCommitFile[] | undefined;
  openPath: string | null;
  diffs: Record<string, WorkspaceCommitDiff>;
  onToggle: () => void;
  onSelectPath: (path: string) => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <li className={expanded ? "bg-muted/30" : ""}>
      <button
        type="button"
        aria-expanded={expanded}
        // The subject leads, because it is what a reader is scanning for. The hash and the age
        // follow it in the name for the same reason they are drawn: they are how two commits with
        // one subject are told apart.
        aria-label={`${commit.subject}, ${commit.shortHash}, ${age(commit.committedAt, now)}`}
        onClick={onToggle}
        className={`${ROW} min-h-11 py-1.5`}
      >
        <Chevron aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-sm text-foreground">{commit.subject}</span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{commit.shortHash}</span>
            <span className="truncate">{commit.author}</span>
            {commit.parentCount > 1
              // A merge's file list is read against its first parent, so what it shows is what the
              // merge brought in rather than everything both sides did. Said here because the
              // number of files would otherwise be surprising.
              ? <span className="shrink-0 rounded bg-muted px-1 text-[10px]">merge</span>
              : null}
          </span>
        </span>
        <span className="shrink-0 self-start pt-0.5 text-xs text-muted-foreground">
          {age(commit.committedAt, now)}
        </span>
      </button>

      {expanded
        ? files === undefined
          ? <Waiting label="Reading what it changed…" />
          : files.length === 0
            ? (
              <p className="m-0 px-9 py-2 text-xs text-muted-foreground">
                No file changes against the previous commit.
              </p>
            )
            : (
              <ul aria-label={`Files in ${commit.shortHash}`} className="m-0 list-none p-0 pb-1">
                {files.map((file) => (
                  <ChangedFile
                    key={file.path}
                    file={file}
                    open={file.path === openPath}
                    diff={diffs[`${commit.hash}:${file.path}`]}
                    onToggle={() => onSelectPath(file.path)}
                  />
                ))}
              </ul>
            )
        : null}
    </li>
  );
}

function ChangedFile({
  file,
  open,
  diff,
  onToggle,
}: {
  file: WorkspaceCommitFile;
  open: boolean;
  diff: WorkspaceCommitDiff | undefined;
  onToggle: () => void;
}) {
  const cut = file.path.lastIndexOf("/");
  const name = cut < 0 ? file.path : file.path.slice(cut + 1);
  const directory = cut < 0 ? "" : file.path.slice(0, cut);
  const tone = gitStatusTone(file.status);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} the diff for ${file.path}`}
        title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        onClick={onToggle}
        className={`${ROW} min-h-9 py-1 pl-8 text-xs`}
      >
        <span
          className={`grid h-[17px] min-w-[18px] shrink-0 place-items-center rounded px-1
            font-mono text-[10px] leading-none ${TONE_BADGE[tone]}`}
        >
          {file.status}
        </span>
        <FileIcon name={name} />
        <span className={`shrink-0 truncate ${tone === "deleted" ? "line-through" : ""}`}>
          {name}
        </span>
        <span className="min-w-0 flex-1 basis-0 truncate text-[11px] text-muted-foreground">
          {directory}
        </span>
        {/* Null counts mean git could not count them, which is what a binary file gets. Saying
            "binary" is the honest version of the two zeroes that would otherwise be drawn. */}
        <span className="shrink-0 font-mono text-[11px]">
          {file.additions === null || file.deletions === null
            ? <span className="text-muted-foreground">binary</span>
            : (
              <>
                <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                {" "}
                <span className="text-rose-600 dark:text-rose-400">-{file.deletions}</span>
              </>
            )}
        </span>
      </button>
      {open ? (diff === undefined ? <Waiting label="Reading the diff…" /> : <Diff diff={diff} />) : null}
    </li>
  );
}

const LINE_TONE: Record<PatchLine["kind"], string> = {
  hunk: "bg-muted text-muted-foreground",
  added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  removed: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  context: "text-foreground",
  meta: "text-muted-foreground",
};

/**
 * The patch, one row per line, with both files' line numbers in the gutter.
 *
 * Scrolled horizontally on its own rather than wrapped: a wrapped diff line loses the alignment
 * that makes two versions comparable, and this panel is narrow enough that wrapping would be the
 * common case rather than the exception.
 */
function Diff({ diff }: { diff: WorkspaceCommitDiff }) {
  const lines = parsePatch(diff.patch);
  return (
    <div className="mx-2 mb-2 overflow-hidden rounded border border-border bg-background">
      <div className="max-h-[260px] overflow-auto">
        <pre className="m-0 w-max min-w-full p-0 font-mono text-[11px] leading-[18px]">
          {lines.map((line, index) => (
            // The index is the key because a patch is a list of lines rather than of entities:
            // two identical lines are two rows, and nothing in it is reordered or removed.
            <div key={index} className={`flex ${LINE_TONE[line.kind]}`}>
              <span aria-hidden className="w-9 shrink-0 select-none px-1 text-right
                text-muted-foreground/70"
              >
                {line.oldNumber ?? ""}
              </span>
              <span aria-hidden className="w-9 shrink-0 select-none px-1 text-right
                text-muted-foreground/70"
              >
                {line.newNumber ?? ""}
              </span>
              <span className="whitespace-pre px-2">{line.text}</span>
            </div>
          ))}
        </pre>
      </div>
      {diff.truncated
        ? (
          <p className="m-0 border-t border-border px-2 py-1 text-[11px] text-muted-foreground">
            This diff was cut short. Read the rest in a terminal.
          </p>
        )
        : null}
    </div>
  );
}
