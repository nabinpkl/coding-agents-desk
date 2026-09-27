// A Bot's uncommitted changes: the files on one side, the chosen file's diff on the other.
//
// Both halves are the IDE's. The list is its source-control section and the diff is the renderer
// its commit history draws with, so a change reads the same wherever a reader meets it. What is
// the Bot's own is only where the answers come from: its directory, on its machine.
//
// Side by side where there is room for a diff beside a list; on a phone, one at a time, with the
// list first and a way back from the diff.

import { ArrowLeft, Loader2, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BotGitDiff, BotGitStatus, BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { PatchView } from "@/features/workspace-ide/history/PatchView";
import { SourceControl } from "@/features/workspace-ide/sidebar/SourceControl";
import { changedFileCount, changedLabel } from "@/features/workspace-ide/sidebar/gitTones";

/** Stops an event at the dialog, for the reason given where it is attached. */
const stop = (event: React.SyntheticEvent): void => event.stopPropagation();

export function BotGitDialog({
  bot,
  feed,
  status,
  error,
  onRefresh,
  onClose,
}: {
  bot: BotView;
  feed: SidecarDataSource;
  status: BotGitStatus;
  /** The last status read's failure, shown over a list that may be out of date because of it. */
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node || node.open) return;
    if (typeof node.showModal === "function") node.showModal();
    else node.setAttribute("open", "");
  }, []);

  // A file committed or reverted while it was open is no longer a change, and asking for its diff
  // would answer a 404 about a file the reader can see is gone from the list.
  const paths = status.entries.map((entry) => entry.relativePath);
  const stillChanged = selected !== null && paths.includes(selected);
  useEffect(() => {
    if (selected !== null && !stillChanged) setSelected(null);
  }, [selected, stillChanged]);

  const count = changedFileCount(status.entries);

  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="bot-git-title"
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-2 text-foreground backdrop:bg-black/45 open:flex sm:p-4"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      // The dialog is portalled out of the card in the DOM, but React still bubbles its events
      // through the card, and the card's header starts a drag on any press that is not on a
      // button. A press on the diff would otherwise pick the whole Bot up.
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={stop}
    >
      <div className="flex h-full max-h-[48rem] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-border py-2 pr-2 pl-4">
          <div className="min-w-0 flex-1">
            <h2 id="bot-git-title" className="truncate text-base font-semibold">
              Changes in {bot.name}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {status.branch ? <span className="font-mono">{status.branch}</span> : "No branch"}
              {" · "}
              {changedLabel(count)}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Read the changes again"
            title="Refresh"
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
          >
            <RefreshCw className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close changes"
            title="Close"
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        {error ? (
          <p role="alert" className="m-0 shrink-0 border-b border-border px-4 py-1.5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(14rem,20rem)_1fr]">
          <nav
            aria-label="Changed files"
            className={`min-h-0 overflow-auto p-1.5 text-sm md:block md:border-r md:border-border
              ${stillChanged ? "hidden" : ""}`}
          >
            <SourceControl entries={status.entries} onOpen={setSelected} selectedPath={selected} />
          </nav>
          <section
            aria-label="Diff"
            className={`min-h-0 flex-col md:flex ${stillChanged ? "flex" : "hidden"}`}
          >
            {stillChanged ? (
              <>
                <div className="flex shrink-0 items-center gap-1 border-b border-border px-1 py-1">
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    aria-label="Back to the changed files"
                    className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70 md:hidden"
                  >
                    <ArrowLeft className="size-4" aria-hidden />
                  </button>
                  <span className="min-w-0 truncate px-1 font-mono text-xs" title={selected}>
                    {selected}
                  </span>
                </div>
                <div className="min-h-0 flex-1">
                  <BotFileDiff feed={feed} botId={bot.botId} path={selected} status={status} />
                </div>
              </>
            ) : count > 0 ? (
              <p className="m-auto p-6 text-center text-sm text-muted-foreground">
                Choose a file to see its diff.
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}

/**
 * One file's diff, read when it is chosen and again whenever the status is read again.
 *
 * Re-read on each status because the file is being written while it is open: an agent on this Bot
 * may be mid-edit, and a diff fixed at the moment it was clicked would quietly fall behind the list
 * beside it. The previous diff stays up while the next is read, so a refresh does not flash.
 */
function BotFileDiff({
  feed,
  botId,
  path,
  status,
}: {
  feed: SidecarDataSource;
  botId: string;
  path: string;
  status: BotGitStatus;
}) {
  const [diff, setDiff] = useState<BotGitDiff | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    setDiff(null);
    setFailure(null);
  }, [botId, path]);

  useEffect(() => {
    let live = true;
    feed.botGitDiff(botId, path).then(
      (answer) => {
        if (!live) return;
        setDiff(answer);
        setFailure(null);
      },
      (cause: unknown) => {
        if (live) setFailure(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [feed, botId, path, status]);

  if (failure !== null && diff === null) {
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      {failure !== null ? (
        <p role="alert" className="m-0 shrink-0 px-2 py-1 text-xs text-destructive">
          Could not read this diff again: {failure}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <PatchView diff={diff} />
      </div>
    </div>
  );
}
