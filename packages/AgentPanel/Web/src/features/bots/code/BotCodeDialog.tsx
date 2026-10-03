// A quick look into a Bot's directory: its files or its uncommitted changes on the left, the
// chosen file or diff on the right. The code button opens it on the files and the git button on
// the changes; it is one modal either way, switched with the IDE's own section tabs.
//
// Every piece is the IDE's -- its explorer tree, its source-control list, the file body its editor
// pane draws with, and the patch renderer its history uses -- so a file and a change read the same
// here as there. What differs is that this only reads: it is for finding your way around what a
// Bot is working on, and the IDE is where its files are changed.
//
// Side by side where there is room; on a phone, one at a time, with the list first and a way back
// from the file.

import { ArrowLeft, FileCode2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { BotView, WorkspaceGitEntry } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useBotCode } from "@/features/bots/code/useBotCode";
import { BACK_TO_LIST, BotWideDialog } from "@/features/bots/dialogs/BotWideDialog";
import type { BotGitState } from "@/features/bots/git/useBotGitStatus";
import {
  defaultFileView,
  FILE_CONTROL,
  FILE_CONTROL_LABELLED,
  FileBody,
  FileViewToggle,
} from "@/features/workspace-ide/editor/FileBody";
import { ReadPatchView } from "@/features/workspace-ide/history/PatchView";
import { changedFileCount, changedLabel } from "@/features/workspace-ide/sidebar/gitTones";
import { SidebarSections, type SidebarSection } from "@/features/workspace-ide/sidebar/SidebarSections";
import { SourceControl } from "@/features/workspace-ide/sidebar/SourceControl";
import { WorkspaceTree } from "@/features/workspace-ide/sidebar/WorkspaceTree";

/** What the right-hand pane is showing: a file, or one path's uncommitted change. */
type Showing = { kind: "file"; path: string } | { kind: "change"; path: string } | null;

export function BotCodeDialog({
  bot,
  feed,
  git,
  initialSection,
  onClose,
}: {
  bot: BotView;
  feed: SidecarDataSource;
  /** The card's git subscription: the changes list, and what makes the files re-read. */
  git: BotGitState;
  initialSection: SidebarSection;
  onClose: () => void;
}) {
  const { status } = git;
  const repository = status?.repository === true;
  const entries = status?.entries ?? [];
  const count = changedFileCount(entries);
  const code = useBotCode(feed, bot.botId, status);
  const [section, setSection] = useState<SidebarSection>(
    initialSection === "sourceControl" && !repository ? "explorer" : initialSection,
  );
  const [showing, setShowing] = useState<Showing>(null);
  // The reader's choice for each file this look, falling back to the kind's own default. Only
  // markdown has two views worth offering here: the IDE's preview of any other source kind is the
  // same text without its line numbers.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});

  // A change committed or reverted while its diff was open is no longer a change, and asking for
  // it would answer a 404 about a row the reader can see is gone from the list.
  const changeGone = showing?.kind === "change"
    && !entries.some((entry) => entry.relativePath === showing.path);
  useEffect(() => {
    if (changeGone) setShowing(null);
  }, [changeGone]);

  const openFile = (path: string): void => {
    code.open(path);
    setShowing({ kind: "file", path });
  };
  const file = showing?.kind === "file" ? code.file : null;
  const preview = file ? chosen[file.path] ?? defaultFileView(file.kind) === "preview" : false;

  return (
    <BotWideDialog
      titleId="bot-code-title"
      title={bot.name}
      subtitle={(
        <>
          <span className="font-mono">{bot.environment.path}</span>
          {repository ? (
            <>
              {" · "}
              {status?.branch ? <span className="font-mono">{status.branch}</span> : "No branch"}
              {" · "}
              {changedLabel(count)}
            </>
          ) : null}
        </>
      )}
      closeLabel="Close"
      error={code.error ?? git.error}
      onClose={onClose}
    >
      {/* One row that fills the dialog rather than sizing to its content: an auto row takes the
          file's natural height, so a long document outgrows the modal and reads as cut off --
          the scroller inside only engages once every ancestor above it has a bounded height.
          The file column is `minmax(0, ...)` for the same reason sideways: a grid item's
          automatic minimum is its content, so one wide table would push the column past the
          modal instead of scrolling inside it. */}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] md:grid-cols-[minmax(14rem,20rem)_minmax(0,1fr)]">
        <div
          className={`min-h-0 min-w-0 flex-col md:flex md:border-r md:border-border
            ${showing ? "hidden" : "flex"}`}
        >
          <SidebarSections
            label="Bot sections"
            section={section}
            changed={count}
            sourceControlUnavailable={repository ? undefined : "Not in a git repository"}
            onSelect={setSection}
          />
          <nav
            aria-label={section === "explorer" ? "Files" : "Changed files"}
            className="min-h-0 flex-1 overflow-auto p-1.5 text-sm"
          >
            {section === "sourceControl" ? (
              <SourceControl
                entries={entries}
                onOpen={(path) => setShowing({ kind: "change", path })}
                selectedPath={showing?.kind === "change" ? showing.path : null}
              />
            ) : code.tree === null ? (
              <p className="m-0 p-2 text-muted-foreground">Listing files…</p>
            ) : code.tree.length === 0 ? (
              <p className="m-0 p-2 text-muted-foreground">This directory is empty.</p>
            ) : (
              <WorkspaceTree
                nodes={code.tree}
                activePath={showing?.kind === "file" ? showing.path : null}
                // Name order, which is what the sidecar sends, and the only order this modal has:
                // it is a look at somebody else's directory rather than a workspace being worked in,
                // so there is nothing here to remember an arrangement in.
                order="name"
                onOpen={openFile}
                onToggle={code.toggle}
              />
            )}
          </nav>
        </div>
        <section
          aria-label={showing?.kind === "change" ? "Diff" : "File"}
          className={`min-h-0 min-w-0 flex-col md:flex ${showing ? "flex" : "hidden"}`}
        >
          {showing ? (
            <>
              <div className="flex shrink-0 items-center gap-1 border-b border-border px-1 py-1">
                <button
                  type="button"
                  onClick={() => setShowing(null)}
                  aria-label={section === "explorer" ? "Back to the files" : "Back to the changed files"}
                  className={BACK_TO_LIST}
                >
                  <ArrowLeft className="size-4" aria-hidden />
                </button>
                <span className="min-w-0 flex-1 truncate px-1 font-mono text-xs" title={showing.path}>
                  {showing.path}
                </span>
                {/* From a diff to what the file says now, which is where a reader goes next about
                    half the time. Absent for a deleted path, which has nothing to open. */}
                {showing.kind === "change" && !isDeleted(entries, showing.path) ? (
                  <button
                    type="button"
                    aria-label={`Open ${showing.path}`}
                    onClick={() => openFile(showing.path)}
                    className={`${FILE_CONTROL} ${FILE_CONTROL_LABELLED}`}
                  >
                    <FileCode2 className="size-3.5" />
                    Open file
                  </button>
                ) : null}
                {file?.kind === "markdown" ? (
                  <FileViewToggle
                    preview={preview}
                    editable={false}
                    onToggle={() => setChosen((current) => ({ ...current, [file.path]: !preview }))}
                  />
                ) : null}
              </div>
              <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
                {showing.kind === "change" ? (
                  // Re-read on each pushed status, because an agent on this Bot may be mid-edit.
                  <ReadPatchView
                    subject={`${bot.botId}:${showing.path}`}
                    refresh={status}
                    read={() => feed.botGitDiff(bot.botId, showing.path)}
                  />
                ) : file ? (
                  <FileBody file={file} preview={preview} />
                ) : (
                  <p className="m-0 p-6 text-center text-sm text-muted-foreground">Opening file…</p>
                )}
              </div>
            </>
          ) : (
            <p className="m-auto p-6 text-center text-sm text-muted-foreground">
              {section === "explorer"
                ? "Choose a file to read it."
                : count > 0 ? "Choose a file to see its diff." : "No uncommitted changes."}
            </p>
          )}
        </section>
      </div>
    </BotWideDialog>
  );
}

/** Whether git reports the path deleted, in the index or the working tree. */
function isDeleted(entries: readonly WorkspaceGitEntry[], path: string): boolean {
  const entry = entries.find((each) => each.relativePath === path);
  return entry?.indexStatus === "D" || entry?.workTreeStatus === "D";
}
