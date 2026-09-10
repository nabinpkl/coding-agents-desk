// The tab strip. One tab per open path, in the order the shared state holds.

import { useRef } from "react";
import { X } from "lucide-react";
import type { OpenFile } from "@/features/workspace-ide/useWorkspaceIde";
import { orderedPathsAfterMove } from "@/features/workspace-ide/editor/orderedPaths";

export function EditorTabs({
  paths,
  openFiles,
  activePath,
  onSelect,
  onClose,
  onReorder,
}: {
  paths: readonly string[];
  openFiles: Record<string, OpenFile>;
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (paths: string[]) => void;
}) {
  const dragged = useRef<string | null>(null);

  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex min-w-0 shrink-0 overflow-x-auto overflow-y-hidden border-b border-border
        bg-background [scrollbar-width:thin]"
    >
      {paths.map((path) => {
        const name = path.split("/").pop() ?? path;
        const file = openFiles[path];
        const selected = path === activePath;
        return (
          <div
            key={path}
            draggable
            onDragStart={() => {
              dragged.current = path;
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              const source = dragged.current;
              dragged.current = null;
              if (source) onReorder(orderedPathsAfterMove(paths, source, path));
            }}
            // The accent bar is drawn inside the tab so selecting one does not shift the row.
            className={`flex min-w-[100px] max-w-[210px] shrink-0 items-stretch border-r
              border-border ${selected ? "bg-muted shadow-[inset_0_2px_var(--color-primary)]" : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={`Open ${name}`}
              onClick={() => onSelect(path)}
              title={path}
              className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden
                whitespace-nowrap pl-2.5 pr-1 text-ellipsis outline-none hover:bg-muted/60
                focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
            >
              <span className="overflow-hidden text-ellipsis">{name}</span>
              <TabState file={file} />
            </button>
            <button
              type="button"
              aria-label={`Close ${name}`}
              onClick={() => onClose(path)}
              className="grid w-7 shrink-0 place-items-center text-muted-foreground outline-none
                hover:bg-muted hover:text-foreground focus-visible:ring-2
                focus-visible:ring-primary focus-visible:ring-inset"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The one mark that says whether a tab has work in it, and whether that work is in trouble. */
function TabState({ file }: { file: OpenFile | undefined }) {
  if (!file || file.saveState === "clean") return null;
  if (file.saveState === "conflict") {
    return <span aria-label="Conflicted" className="font-bold text-destructive">!</span>;
  }
  if (file.saveState === "saving") {
    return <span className="text-[9px] text-muted-foreground">saving</span>;
  }
  return <span aria-label="Unsaved" className="text-[9px] text-primary">●</span>;
}
