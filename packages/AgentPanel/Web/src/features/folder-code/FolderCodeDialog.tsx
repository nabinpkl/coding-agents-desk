// A quick look into a folder somebody else is working in -- a Bot's directory, an arena run's
// folder, a contestant's worktree: its files or its uncommitted changes on the left, the chosen
// file or diff on the right. A code button opens it on the files and a git button on the changes;
// it is one modal either way, switched with the IDE's own section tabs.
//
// Every piece is the IDE's -- its explorer tree, its source-control list, the file body its editor
// pane draws with, and the patch renderer its history uses -- so a file and a change read the same
// here as there. What differs is that this only reads: it is for finding your way around what an
// agent is working on, and the IDE is where files are changed.
//
// Side by side where there is room; on a phone, one at a time, with the list first and a way back
// from the file.

import { ArrowLeft, FileCode2 } from "lucide-react";
import { useState } from "react";
import type { WorkspaceGitEntry } from "@agentdesk/agent-feed-wire";
import type { FilePathTarget } from "@/features/activity-feed/markdown/filePathLinks";
import type { FolderGitState, FolderSource } from "@/features/folder-code/folderSource";
import { BACK_TO_LIST, FolderWideDialog } from "@/features/folder-code/FolderWideDialog";
import { useFolderCode } from "@/features/folder-code/useFolderCode";
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

export function FolderCodeDialog({
  titleId,
  title,
  path,
  sectionsLabel,
  source,
  git,
  initialSection,
  initialFile = null,
  onClose,
}: {
  /** The heading's id, which names the dialog. Unique per kind of folder. */
  titleId: string;
  /** Whose folder this is: the Bot's name, the run's, the contestant's. */
  title: string;
  /** Where the folder is on the disk, which the subtitle leads with. */
  path: string;
  /** The section tabs' accessible name. */
  sectionsLabel: string;
  /** Keep it stable: a different source is a different folder, read from scratch. */
  source: FolderSource;
  /** The folder's git subscription: the changes list, and what makes the files re-read. */
  git: FolderGitState;
  initialSection: SidebarSection;
  /** A file to open on, named in a session's transcript; its line is scrolled to and marked. */
  initialFile?: FilePathTarget | null;
  onClose: () => void;
}) {
  const { status } = git;
  const repository = status?.repository === true;
  const entries = status?.entries ?? [];
  const count = changedFileCount(entries);
  const code = useFolderCode(source, status, initialFile?.path ?? null);
  const [section, setSection] = useState<SidebarSection>(
    initialSection === "sourceControl" && !repository ? "explorer" : initialSection,
  );
  const [showing, setShowing] = useState<Showing>(
    initialFile === null ? null : { kind: "file", path: initialFile.path },
  );
  // The reader's choice for each file this look, falling back to the kind's own default. Only
  // markdown has two views worth offering here: the IDE's preview of any other source kind is the
  // same text without its line numbers.
  // A named line is in the source, so a markdown file asked for at a line opens there rather than
  // on its preview, which has no lines to mark.
  const [chosen, setChosen] = useState<Record<string, boolean>>(
    () => (initialFile?.line == null ? {} : { [initialFile.path]: false }),
  );

  // A change committed or reverted while its diff was open is no longer a change, and asking for
  // it would answer a 404 about a row the reader can see is gone from the list.
  const changeGone = showing?.kind === "change"
    && !entries.some((entry) => entry.relativePath === showing.path);
  if (changeGone) setShowing(null);

  const openFile = (path: string): void => {
    code.open(path);
    setShowing({ kind: "file", path });
  };
  const file = showing?.kind === "file" ? code.file : null;
  const preview = file ? chosen[file.path] ?? defaultFileView(file.kind) === "preview" : false;

  return (
    <FolderWideDialog
      titleId={titleId}
      title={title}
      subtitle={(
        <>
          <span className="font-mono">{path}</span>
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
            label={sectionsLabel}
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
                // it is a look at somebody else's folder rather than a workspace being worked in,
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
                  // Re-read on each pushed status, because an agent in this folder may be mid-edit.
                  <ReadPatchView
                    subject={`${source.key}:${showing.path}`}
                    refresh={status}
                    read={() => source.gitDiff(showing.path)}
                  />
                ) : file ? (
                  <FileBody
                    file={file}
                    preview={preview}
                    reveal={initialFile?.line != null && file.path === initialFile.path
                      ? { line: initialFile.line, start: 0, end: 0, nonce: 1 }
                      : undefined}
                  />
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
    </FolderWideDialog>
  );
}

/** Whether git reports the path deleted, in the index or the working tree. */
function isDeleted(entries: readonly WorkspaceGitEntry[], path: string): boolean {
  const entry = entries.find((each) => each.relativePath === path);
  return entry?.indexStatus === "D" || entry?.workTreeStatus === "D";
}
