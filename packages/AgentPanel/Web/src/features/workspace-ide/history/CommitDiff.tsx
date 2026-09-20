// One file as a commit left it, in the editor: the tab, the patch, and the colours.
//
// The diff opens in the editor rather than inside the history popup, which is where it used to be
// drawn. A patch read in a 460px popup is read through a letterbox, and the reader has the whole
// editor sitting behind it -- the same place they would open the file itself, with the same tabs
// to get back to what they were doing. It is the shape every editor uses for this.
//
// Apart from the popup that lists the commits, because it is a different concern with a different
// reader: that is a list of what happened, and this is the text of one change. The renderer takes
// a patch rather than a place in the history, so the source-control list can use it later for the
// diff of a file nobody has committed yet.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { WorkspaceCommit, WorkspaceCommitDiff, WorkspaceCommitFile } from "@agentdesk/agent-feed-wire";
import type { WorkspaceIdeClient } from "@/features/workspace-ide/workspaceIdeClient";
import { SHIKI_THEMES, useCodeHighlighting } from "@/features/activity-feed/markdown/highlighter";
// The rule that reads Shiki's per-token variables, for the reason the editor imports it too: a
// surface that emits perfectly tokenised markup and depends on a stylesheet nothing here mentions
// is one import away from silently going grey.
import "@/features/activity-feed/markdown/markdown.css";
import { parsePatch, patchSides, type PatchLine } from "@/features/workspace-ide/history/gitPatch";

/**
 * The row's background, and the ink for anything the grammar does not colour.
 *
 * The tint is what says added or removed; the ink under the tokens is what a line falls back to
 * where shiki has no grammar, or has not loaded one yet. An added line therefore reads as added
 * before it is coloured and after, which is what keeps the panel from flashing a different shape
 * when the grammar arrives.
 */
const LINE_TONE: Record<PatchLine["kind"], string> = {
  hunk: "bg-muted text-muted-foreground",
  added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  removed: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  context: "text-foreground",
  meta: "text-muted-foreground",
};

/**
 * Past this many lines the patch is drawn without colour.
 *
 * Tokenizing runs on the main thread, and a generated file's rewrite is tens of thousands of lines
 * of it. A diff nobody can read because the panel froze is worse than a grey one.
 */
const HIGHLIGHT_LINE_CEILING = 3000;

/** One file of one commit, which is what a diff tab is pointed at. */
export interface CommitDiffTarget {
  hash: string;
  shortHash: string;
  path: string;
}

export interface CommitDiffTab {
  /** What the tab is showing, or null when there is no diff tab at all. */
  target: CommitDiffTarget | null;
  /** Whether the diff is the pane's content right now, as against a file tab being selected. */
  active: boolean;
  open(commit: WorkspaceCommit, file: WorkspaceCommitFile): void;
  /** Select the existing diff tab, which is what clicking it does. */
  show(): void;
  /** Leave the diff on its tab and show a file instead. */
  hide(): void;
  close(): void;
}

/**
 * The editor's one diff tab.
 *
 * One rather than a tab per commit: two diffs of the same file in different commits are told apart
 * only by seven characters of hash, so a strip of them is a row of near-identical tabs. Opening a
 * second diff replaces the first, and the file tabs beside it are untouched either way.
 *
 * Local state, not the workspace's shared state: what one reader is looking back at is not
 * something to push onto everybody else's screen, and the shared state stores paths, which a
 * commit and a path together are not.
 */
export function useCommitDiffTab(): CommitDiffTab {
  const [target, setTarget] = useState<CommitDiffTarget | null>(null);
  const [active, setActive] = useState(false);
  return {
    target,
    active: active && target !== null,
    open: useCallback((commit: WorkspaceCommit, file: WorkspaceCommitFile) => {
      setTarget({ hash: commit.hash, shortHash: commit.shortHash, path: file.path });
      setActive(true);
    }, []),
    show: useCallback(() => setActive(true), []),
    hide: useCallback(() => setActive(false), []),
    close: useCallback(() => {
      setTarget(null);
      setActive(false);
    }, []),
  };
}

/**
 * The patch for one file of one commit, fetched when the tab is pointed at it.
 *
 * The read happens here rather than in whatever opened the tab, so a tab that is reopened on the
 * same file re-reads rather than drawing a patch from before the branch moved.
 */
export function CommitDiffView({
  client,
  workspaceId,
  target,
}: {
  client: WorkspaceIdeClient;
  workspaceId: string;
  target: CommitDiffTarget;
}) {
  const [diff, setDiff] = useState<WorkspaceCommitDiff | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { hash, path } = target;

  useEffect(() => {
    let live = true;
    setDiff(null);
    setFailure(null);
    client.commitDiff(workspaceId, hash, path)
      .then((answer) => {
        if (live) setDiff(answer.diff);
      })
      .catch((cause: unknown) => {
        if (live) setFailure(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [client, workspaceId, hash, path]);

  if (failure !== null) {
    return (
      <p role="status" className="m-0 p-6 text-center text-sm text-destructive">
        {failure}
      </p>
    );
  }
  if (diff === null) {
    return (
      <p className="m-0 flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        Reading the diff…
      </p>
    );
  }
  return <CommitPatch diff={diff} />;
}

/**
 * The patch, one row per line, with both files' line numbers in the gutter.
 *
 * Scrolled horizontally on its own rather than wrapped: a wrapped diff line loses the alignment
 * that makes two versions comparable, and this panel is narrow enough that wrapping would be the
 * common case rather than the exception.
 *
 * The colours are the panel's own highlighter, the same Shiki instance and grammars the editor
 * paints a file with, so a line looks the same in the diff as it does in the file it came from.
 */
function CommitPatch({ diff }: { diff: WorkspaceCommitDiff }) {
  const lines = useMemo(() => parsePatch(diff.patch), [diff.patch]);
  // The path rather than an extension: the highlighter takes a file name as readily as a fence
  // language, which is what gives `Justfile` and `Dockerfile` a grammar at all.
  const { highlighter, lang } = useCodeHighlighting(diff.path);
  const painted = useMemo(() => {
    if (!highlighter || lines.length > HIGHLIGHT_LINE_CEILING) return null;
    const sides = patchSides(lines);
    const options = { lang, themes: SHIKI_THEMES, defaultColor: false } as const;
    return {
      old: highlighter.codeToTokens(sides.oldCode, options).tokens,
      fresh: highlighter.codeToTokens(sides.newCode, options).tokens,
      places: sides.places,
    };
  }, [highlighter, lang, lines]);

  return (
    // The whole pane, scrolling in both directions: this is the editor's content now rather than a
    // box inside a list, so the only ceiling on it is the pane it fills.
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Named, because a screen reader meeting this otherwise meets an unlabelled wall of
            code with no way to tell which file it belongs to. */}
        <pre
          aria-label={`Diff of ${diff.path}`}
          className="m-0 w-max min-w-full p-0 font-mono text-[11px] leading-[18px]"
        >
          {lines.map((line, index) => {
            const place = painted?.places[index] ?? null;
            const tokens = place === null
              ? null
              : (place.side === "old" ? painted!.old : painted!.fresh)[place.line] ?? null;
            return (
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
                {/* `shiki` on the code span and not on the row, because the rule that reads the
                    per-token variables paints every span under it -- and the two gutters are
                    spans with no token colour of their own to read. */}
                <span className={`whitespace-pre px-2 ${tokens ? "shiki" : ""}`}>
                  {tokens
                    ? tokens.map((token, at) => (
                      <span key={at} style={token.htmlStyle}>{token.content}</span>
                    ))
                    : line.text}
                </span>
              </div>
            );
          })}
        </pre>
      </div>
      {diff.truncated
        ? (
          <p className="m-0 shrink-0 border-t border-border px-2 py-1 text-[11px]
            text-muted-foreground">
            This diff was cut short. Read the rest in a terminal.
          </p>
        )
        : null}
    </div>
  );
}
