// What is already committed, as a panel that rises from the status bar.
//
// The IDE had no way to look backwards at all: the sidebar answers what is changed NOW, and the
// editor answers what a file says now. This answers the other question a reader of a repository
// asks constantly -- what landed, and what did it do -- without leaving the surface for a terminal.
//
// A list rather than a reader: the log, then what one commit says and what it touched. The diff
// itself opens in the editor behind this panel, which is where a patch is worth reading.
//
// Each level is fetched only when it is asked for. The log arrives with the panel; a commit's
// message and file list cost three `git show` passes and wait for the commit to be expanded. A
// panel that fetched all of that for fifty commits up front would read the whole repository to
// draw a list of subjects.
//
// Nothing done to the editor closes this panel: not clicking a file here, and not clicking in the
// editor afterwards. A reader who has found the commit is usually reading several of its files,
// and a panel that dismissed itself would make the second file cost the whole journey again. What
// it costs is that the diff opens behind the panel -- on a phone, entirely behind it -- so the row
// marks itself as the one the editor is showing.
//
// The reading position lives in `useCommitHistory`, on the status bar, so that dismissing this
// panel deliberately -- Escape, or a click in the sidebar or the terminal -- does not throw away
// the commit it was open on either.

import { useId, useState } from "react";
import { focusOnMount } from "@/hooks/refCallbacks";
import { ChevronDown, ChevronRight, GitCommitHorizontal, Loader2, X } from "lucide-react";
import type {
  WorkspaceCommit,
  WorkspaceCommitDetail,
  WorkspaceCommitFile,
} from "@agentdesk/agent-feed-wire";
import type { CommitDiffTarget } from "@/features/workspace-ide/history/CommitDiff";
import type { CommitHistory } from "@/features/workspace-ide/history/useCommitHistory";
import { PAGE } from "@/features/workspace-ide/history/useCommitHistory";
import { FileIcon } from "@/features/workspace-ide/sidebar/FileIcon";
import { gitStatusTone, TONE_BADGE } from "@/features/workspace-ide/sidebar/gitTones";

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

export function WorkspaceIdeHistory({
  id,
  history,
  showing,
  onOpenDiff,
  onClose,
}: {
  /** The popup's element id, so the control that opened it can point at it with `aria-controls`. */
  id: string;
  history: CommitHistory;
  /** What the editor's diff tab is pointed at, so the row that put it there reads as current. */
  showing: CommitDiffTarget | null;
  onOpenDiff: (commit: WorkspaceCommit, file: WorkspaceCommitFile) => void;
  onClose: () => void;
}) {
  const { commits, failure, limit, openHash, details } = history;

  const now = Date.now();
  return (
    <div
      id={id}
      // The panel takes focus when it opens: it is the thing the reader just asked for, and Escape
      // has to reach it from somewhere. The control that opened it takes focus back on close.
      ref={focusOnMount}
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
                    detail={details[commit.hash]}
                    showing={showing?.commit?.hash === commit.hash ? showing.path : null}
                    onToggle={() => history.toggleCommit(commit.hash)}
                    onSelectFile={(file) => onOpenDiff(commit, file)}
                  />
                ))}
              </ul>
            )}
        {commits !== null && commits.length >= limit
          ? (
            <button
              type="button"
              onClick={history.showMore}
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
  detail,
  showing,
  onToggle,
  onSelectFile,
}: {
  commit: WorkspaceCommit;
  now: number;
  expanded: boolean;
  /** Its message and files, or undefined while the read is in flight. */
  detail: WorkspaceCommitDetail | undefined;
  /** The path of this commit's file that the editor is showing, if it is showing one. */
  showing: string | null;
  onToggle: () => void;
  onSelectFile: (file: WorkspaceCommitFile) => void;
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
        ? detail === undefined
          ? <Waiting label="Reading what it changed…" />
          : (
            <>
              {/* Above the files, because it is why they changed. A commit with no message below
                  its subject draws nothing here rather than an empty block. */}
              {detail.body === "" ? null : <CommitMessage body={detail.body} />}
              {detail.files.length === 0
                ? (
                  <p className="m-0 px-9 py-2 text-xs text-muted-foreground">
                    No file changes against the previous commit.
                  </p>
                )
                : (
                  <ul aria-label={`Files in ${commit.shortHash}`} className="m-0 list-none p-0 pb-1">
                    {detail.files.map((file) => (
                      <ChangedFile
                        key={file.path}
                        file={file}
                        showing={file.path === showing}
                        onOpen={() => onSelectFile(file)}
                      />
                    ))}
                  </ul>
                )}
            </>
          )
        : null}
    </li>
  );
}

/**
 * How much of a message is drawn before it is worth offering to cut.
 *
 * Both, because either alone misses one shape: a wall of a paragraph is one line, and eight short
 * lines are two hundred characters. Measured against the text rather than against the rendered
 * box, so what the control hides is exactly what the count says -- a height cut with `line-clamp`
 * would silently swallow a five-line message whose lines happen to wrap.
 */
const MESSAGE_LINES = 6;
const MESSAGE_CHARACTERS = 400;

/**
 * What the author wrote under the subject.
 *
 * Monospace and pre-wrapped, because a commit message is written into a fixed-width terminal: its
 * wrapping, its indented lists and its pasted lines are the author's layout, and reflowing them as
 * prose loses the only formatting the format has.
 *
 * Long ones open cut rather than whole. This panel is a log first -- the commit above and the
 * files below are what a reader is navigating by -- and a forty-line message would push both off
 * a 460px panel. The reader who came for the message says so, and the state is deliberately not
 * remembered anywhere: it costs one click, and a panel that reopened mid-message would be
 * remembering the wrong thing.
 */
function CommitMessage({ body }: { body: string }) {
  const [whole, setWhole] = useState(false);
  const id = useId();
  const lines = body.split("\n");
  const long = lines.length > MESSAGE_LINES || body.length > MESSAGE_CHARACTERS;
  const shown = !long || whole
    ? body
    : `${lines.slice(0, MESSAGE_LINES).join("\n").slice(0, MESSAGE_CHARACTERS).trimEnd()}…`;
  return (
    // Indented to the subject above it rather than to the panel, so the eye reads one block.
    <div className="grid justify-items-start gap-0.5 py-1 pl-8 pr-2">
      {/* Full ink: this is the thing the reader opened the commit for, not an annotation on it. */}
      <p
        id={id}
        className="m-0 whitespace-pre-wrap break-words font-mono text-[11px] leading-[17px]
          text-foreground"
      >
        {shown}
      </p>
      {long
        ? (
          <button
            type="button"
            aria-expanded={whole}
            aria-controls={id}
            onClick={() => setWhole((current) => !current)}
            className="rounded px-1 py-0.5 text-[11px] text-muted-foreground outline-none
              transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2
              focus-visible:ring-primary active:bg-muted/70"
          >
            {whole ? "Show less" : "Show the whole message"}
          </button>
        )
        : null}
    </div>
  );
}

function ChangedFile({
  file,
  showing,
  onOpen,
}: {
  file: WorkspaceCommitFile;
  /** Whether the editor's diff tab is on this file, which is what marks the row as current. */
  showing: boolean;
  onOpen: () => void;
}) {
  const cut = file.path.lastIndexOf("/");
  const name = cut < 0 ? file.path : file.path.slice(cut + 1);
  const directory = cut < 0 ? "" : file.path.slice(0, cut);
  const tone = gitStatusTone(file.status);
  return (
    <li>
      <button
        type="button"
        // `aria-current`, not `aria-pressed`: the row does not hold the diff open, it is the row
        // whose diff the editor happens to be showing, and clicking it again opens it again.
        aria-current={showing ? "true" : undefined}
        aria-label={`Open the diff of ${file.path}`}
        title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        onClick={onOpen}
        className={`${ROW} min-h-9 py-1 pl-8 text-xs ${showing ? "bg-muted" : ""}`}
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
    </li>
  );
}
