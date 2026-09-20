// The tab strip. One tab per visible open path, in the order the shared state holds -- plus any
// file held back from another reader's close because this reader has unsaved text in it, and the
// diff tab when the reader has opened one from the history.

import { useRef } from "react";
import { GitCompare, X } from "lucide-react";
import type { CommitDiffTab } from "@/features/workspace-ide/history/CommitDiff";
import type { OpenFile } from "@/features/workspace-ide/useWorkspaceIde";
import { orderedPathsAfterMove } from "@/features/workspace-ide/editor/orderedPaths";

const TAB = "flex min-w-[100px] max-w-[210px] shrink-0 items-stretch border-r border-border";
const SELECTED = "bg-muted shadow-[inset_0_2px_var(--color-primary)]";
const LABEL = "flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap pl-2.5"
  + " pr-1 text-ellipsis outline-none hover:bg-muted/60 focus-visible:ring-2"
  + " focus-visible:ring-primary focus-visible:ring-inset";
const CLOSE = "grid w-7 shrink-0 place-items-center text-muted-foreground outline-none"
  + " hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
  + " focus-visible:ring-inset";

export function EditorTabs({
  paths,
  openFiles,
  activePath,
  onSelect,
  onClose,
  onReorder,
  diff,
}: {
  paths: readonly string[];
  openFiles: Record<string, OpenFile>;
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (paths: string[]) => void;
  /** The editor's one diff tab, which has no path and so is not one of the tabs above. */
  diff: CommitDiffTab;
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
            className={`${TAB} ${selected ? SELECTED : ""}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              aria-label={`Open ${name}`}
              onClick={() => onSelect(path)}
              title={path}
              className={LABEL}
            >
              <span className="overflow-hidden text-ellipsis">{name}</span>
              <TabState file={file} />
            </button>
            <button
              type="button"
              aria-label={`Close ${name}`}
              onClick={() => onClose(path)}
              className={CLOSE}
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
      {diff.target ? <DiffTab diff={diff} /> : null}
    </div>
  );
}

/**
 * The diff tab, last in the strip and not draggable.
 *
 * Last because it is not part of the shared order -- the files in this strip are what everyone
 * reading this workspace has open, and this is one reader looking backwards. Dragging it would ask
 * the shared order to hold something that has no path.
 */
function DiffTab({ diff }: { diff: CommitDiffTab }) {
  const target = diff.target!;
  const name = target.path.split("/").pop() ?? target.path;
  return (
    <div className={`${TAB} ${diff.active ? SELECTED : ""}`}>
      <button
        type="button"
        role="tab"
        aria-selected={diff.active}
        // Named for what it shows rather than for the file alone, because the strip beside it is
        // full of tabs named for files and this one is not showing a file.
        aria-label={`Show the diff of ${name} in ${target.shortHash}`}
        title={`${target.path} in ${target.shortHash}`}
        onClick={diff.show}
        className={LABEL}
      >
        <GitCompare aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="overflow-hidden text-ellipsis">{name}</span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
          {target.shortHash}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Close the diff of ${name}`}
        onClick={diff.close}
        className={CLOSE}
      >
        <X className="size-3.5" />
      </button>
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
