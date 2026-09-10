// The editor half: tabs, a breadcrumb, the conflict bar, and whatever the active file is.

import { Eye, PanelLeft, PanelBottom, Pencil } from "lucide-react";
import type { WorkspaceIde } from "@/features/workspace-ide/useWorkspaceIde";
import { CodeEditor } from "@/features/workspace-ide/editor/CodeEditor";
import { EditorTabs } from "@/features/workspace-ide/editor/EditorTabs";
import { FilePreview } from "@/features/workspace-ide/editor/FilePreview";

const CONTROL = "grid h-7 w-8 shrink-0 place-items-center rounded-md text-muted-foreground"
  + " outline-none transition-colors hover:bg-muted/60 hover:text-foreground"
  + " focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
  + " aria-pressed:bg-muted aria-pressed:text-foreground";

export function EditorPane({ ide }: { ide: WorkspaceIde }) {
  const { activePath, openFiles, shared, preferences } = ide;
  const file = activePath ? openFiles[activePath] : undefined;
  // A read-only kind is always previewed; an editable one only when the reader asked.
  const readOnlyKind = file?.kind === "docx" || file?.kind === "notebook";
  const preview = Boolean(file) && (readOnlyKind || (activePath ? ide.isPreview(activePath) : false));

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <EditorTabs
        paths={shared?.orderedOpenPaths ?? []}
        openFiles={openFiles}
        activePath={activePath}
        onSelect={ide.activate}
        onClose={ide.closePath}
        onReorder={ide.reorderTabs}
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
          {(activePath ?? "").split("/").filter(Boolean).join(" / ")}
        </nav>
        {file && !readOnlyKind
          ? (
            <button
              type="button"
              aria-label={preview ? "Edit file" : "Show file preview"}
              onClick={() => ide.togglePreview(file.path)}
              className={`${CONTROL} w-auto gap-1 px-2 text-xs`}
            >
              {preview ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
              {preview ? "Edit" : "Preview"}
            </button>
          )
          : null}
        <button
          type="button"
          aria-label="Toggle terminal"
          aria-pressed={preferences.terminalVisible}
          onClick={() => ide.update({ terminalVisible: !preferences.terminalVisible })}
          className={CONTROL}
        >
          <PanelBottom className="size-4" />
        </button>
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
        {file && ide.workspaceId
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
