// What a quick look into a folder's code holds -- a Bot's directory, an arena run's folder, a
// contestant's worktree: its tree as far as the reader has opened it, and the one file they are
// reading.
//
// All of it is this reader's and none of it is stored. The IDE shares its tabs between readers and
// remembers them across reloads because it is where work happens; this is a glance, and a glance
// that came back after a reload rearranged, or showed up rearranged for someone else, would be the
// surprise rather than the convenience.
//
// Nothing here asks on a timer. The tree and the open file are read again when `refresh` moves,
// which the caller ties to the folder's pushed git status: that moves after every change git could
// report, which is every change to a file a reader here could be looking at.

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceTreeNode } from "@agentdesk/agent-feed-wire";
import type { FolderSource } from "@/features/folder-code/folderSource";
import type { ViewedFile } from "@/features/workspace-ide/editor/FilePreview";

export interface FolderCode {
  /** Null until the first answer. */
  tree: WorkspaceTreeNode[] | null;
  openPath: string | null;
  /** The open file, or null while its first read is in flight. Kept across a re-read of itself. */
  file: ViewedFile | null;
  /** The last failure, of the tree or the file, or null since a good answer. */
  error: string | null;
  open(path: string): void;
  toggle(path: string, expanded: boolean): void;
}

/**
 * `initialPath` opens with that file showing and the directories above it expanded, which is how a
 * path named in a session's transcript arrives.
 */
export function useFolderCode(
  /** Keep it stable: a different source is a different folder, read from scratch. */
  source: FolderSource,
  refresh: unknown,
  initialPath: string | null = null,
): FolderCode {
  const [expanded, setExpanded] = useState<string[]>(() => (initialPath === null ? [] : ancestors(initialPath)));
  const [tree, setTree] = useState<WorkspaceTreeNode[] | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(initialPath);
  const [file, setFile] = useState<ViewedFile | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // The tree stays on screen while the next one is read, so an expansion or a pushed change never
  // blanks the list the reader is pointing at.
  useEffect(() => {
    let current = true;
    source.tree(expanded)
      .then((answer) => {
        if (!current) return;
        setTree(answer.tree);
        setTreeError(null);
      })
      .catch((cause: unknown) => {
        if (current) setTreeError(describe(cause, "Could not list the files."));
      });
    return () => {
      current = false;
    };
  }, [source, expanded, refresh]);

  // A different file clears the pane; the same file read again after a change does not.
  useEffect(() => {
    setFile((held) => (held?.path === openPath ? held : null));
    setFileError(null);
  }, [openPath]);

  useEffect(() => {
    if (openPath === null) return;
    let current = true;
    source.file(openPath)
      .then((answer) => {
        if (!current) return;
        setFile({
          path: answer.path,
          kind: answer.kind,
          text: answer.text ?? "",
          revision: answer.revision,
          contentUrl: source.contentUrl(answer.path),
        });
        setFileError(null);
      })
      .catch((cause: unknown) => {
        if (current) setFileError(describe(cause, `Could not open ${openPath}.`));
      });
    return () => {
      current = false;
    };
  }, [source, openPath, refresh]);

  return {
    tree,
    openPath,
    file: file?.path === openPath ? file : null,
    error: fileError ?? treeError,
    open: setOpenPath,
    toggle: useCallback((path: string, open: boolean) => {
      // A collapsed directory's own expanded children are kept: the sidecar lists only what is
      // reachable through expanded parents, so they cost nothing, and reopening it puts the reader
      // back where they were inside it.
      setExpanded((current) => (open
        ? (current.includes(path) ? current : [...current, path])
        : current.filter((each) => each !== path)));
    }, []),
  };
}

/** `a/b/c.ts` -> `["a", "a/b"]`: what has to be expanded for the tree to show the file. */
function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, at) => parts.slice(0, at + 1).join("/"));
}

function describe(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
