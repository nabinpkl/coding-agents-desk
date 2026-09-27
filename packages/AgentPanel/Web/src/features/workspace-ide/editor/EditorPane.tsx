// The editor half: tabs, a breadcrumb, the conflict bar, and whatever the active tab is showing --
// a file, or the diff of one file in one commit or of its uncommitted change.
//
// The toolbar's controls are the ones that act on THIS pane or its neighbour to the left. The
// terminal toggle used to be here too and is now on the IDE's status bar, at the edge of the pane
// it opens rather than three controls away and above it.

import { Eye, FileCode2, PanelLeft, Pencil } from "lucide-react";
import type { CommitDiffTab } from "@/features/workspace-ide/history/CommitDiff";
import { CommitDiffView, diffTargetLabel } from "@/features/workspace-ide/history/CommitDiff";
import type { WorkspaceIde } from "@/features/workspace-ide/useWorkspaceIde";
import { CodeEditor } from "@/features/workspace-ide/editor/CodeEditor";
import { EditorTabs } from "@/features/workspace-ide/editor/EditorTabs";
import { FilePreview } from "@/features/workspace-ide/editor/FilePreview";

// `grid-flow-col` on the labelled variant below, because `CONTROL` is a grid and a grid stacks its
// children: the icon sat on top of its own label in both of the controls that carry one, inside a
// button 28px tall. One row, not two.
const LABELLED = "w-auto grid-flow-col gap-1 px-2 text-xs";

const CONTROL = "grid h-7 w-8 shrink-0 place-items-center rounded-md text-muted-foreground"
  + " outline-none transition-colors hover:bg-muted/60 hover:text-foreground"
  + " focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
  + " aria-pressed:bg-muted aria-pressed:text-foreground";

export function EditorPane({ ide, diff }: { ide: WorkspaceIde; diff: CommitDiffTab }) {
  const { activePath, openFiles, visibleOpenPaths, preferences } = ide;
  const file = activePath ? openFiles[activePath] : undefined;
  // Which kinds open which way is `useWorkspaceIde`'s to answer, including the read-only ones, so
  // that a kind's default lives in one place rather than half here and half beside the toggle.
  const preview = Boolean(file) && (activePath ? ide.isPreview(activePath) : false);
  // Separately: whether there is an editor to switch TO. A notebook and a Word document are drawn
  // from a parsed model and the sidecar refuses a write to either, so no toggle is offered.
  const readOnlyKind = file?.kind === "docx" || file?.kind === "notebook";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <EditorTabs
        paths={visibleOpenPaths}
        openFiles={openFiles}
        // No file tab is selected while the diff is showing. One tablist reporting two selected
        // tabs is two accent bars to the eye and a contradiction to a screen reader.
        activePath={diff.active ? null : activePath}
        onSelect={(path) => {
          // Selecting a file leaves the diff on its tab rather than closing it: a reader comparing
          // a commit against what the file says now moves between the two, repeatedly.
          diff.hide();
          ide.activate(path);
        }}
        onClose={ide.closePath}
        onReorder={ide.reorderTabs}
        diff={diff}
      />

      <div className="flex min-h-[38px] shrink-0 items-center gap-1 border-b border-border
        bg-muted/40 px-1.5"
      >
        <button
          type="button"
          aria-label="Toggle sidebar"
          aria-pressed={preferences.sidebarVisible}
          onClick={() => ide.update({ sidebarVisible: !preferences.sidebarVisible })}
          className={CONTROL}
        >
          <PanelLeft className="size-4" />
        </button>
        <nav
          aria-label="File breadcrumb"
          className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-xs
            text-muted-foreground"
        >
          {/* The diff's own path, with the commit that changed it: the breadcrumb answers "what am
              I looking at", and while the diff is showing that is not the active file. */}
          {diff.active && diff.target
            ? `${diff.target.path.split("/").filter(Boolean).join(" / ")} · ${diffTargetLabel(diff.target)}`
            : (activePath ?? "").split("/").filter(Boolean).join(" / ")}
        </nav>
        {/* The way out of a diff and into the file it is about, which is where a reader goes next
            about half the time: the patch says what changed, and the question after that is what
            the line says now. Absent for a file the commit deleted -- there is nothing at that
            path to open, and the control would answer a refusal banner. An uncommitted status can
            carry two letters, so a `D` in either one counts.

            It leaves the diff on its tab rather than closing it, so the comparison a reader came
            for is one click away again. */}
        {diff.active && diff.target && !diff.target.status.includes("D")
          ? (
            <button
              type="button"
              aria-label={`Open ${diff.target.path}`}
              onClick={() => {
                const { path } = diff.target!;
                diff.hide();
                ide.openPath(path);
              }}
              className={`${CONTROL} ${LABELLED}`}
            >
              <FileCode2 className="size-3.5" />
              Open file
            </button>
          )
          : null}
        {file && !readOnlyKind && !diff.active
          ? (
            <button
              type="button"
              aria-label={preview ? "Edit file" : "Show file preview"}
              onClick={() => ide.togglePreview(file.path)}
              className={`${CONTROL} ${LABELLED}`}
            >
              {preview ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
              {preview ? "Edit" : "Preview"}
            </button>
          )
          : null}
      </div>

      {file?.saveState === "conflict" && activePath
        ? (
          <div
            role="alert"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border
              bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
          >
            <span className="flex-1">This file changed on disk.</span>
            <button
              type="button"
              onClick={() => ide.useHostVersion(activePath)}
              className="rounded-md border border-current px-2 py-1 outline-none
                focus-visible:ring-2 focus-visible:ring-primary"
            >
              Use theirs
            </button>
            <button
              type="button"
              onClick={() => ide.keepMyVersion(activePath)}
              className="rounded-md border border-current px-2 py-1 outline-none
                focus-visible:ring-2 focus-visible:ring-primary"
            >
              Keep mine
            </button>
          </div>
        )
        : null}

      <main className="relative min-h-0 flex-1 overflow-hidden">
        {diff.active && diff.target && ide.workspaceId
          ? (
            <CommitDiffView
              // Keyed on what it shows, so pointing the tab at another file reads rather than
              // redrawing the previous patch while the new one arrives.
              key={`${diff.target.commit?.hash ?? "uncommitted"}:${diff.target.path}`}
              client={ide.client}
              workspaceId={ide.workspaceId}
              target={diff.target}
              gitRevision={ide.git}
            />
          )
          : file && ide.workspaceId
          ? (preview
            ? <FilePreview file={file} />
            : (
              <CodeEditor
                path={file.path}
                text={file.text}
                readOnly={false}
                onChange={(text) => ide.edit(file.path, text)}
              />
            ))
          : (
            <div className="grid h-full place-items-center p-6 text-center text-muted-foreground">
              {ide.loadingPath ? "Opening file…" : "Open a file from the explorer"}
            </div>
          )}
      </main>
    </div>
  );
}
