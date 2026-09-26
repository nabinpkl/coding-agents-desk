// What a quick look into a Bot's code holds: its tree as far as the reader has opened it, and the
// one file they are reading.
//
// All of it is this reader's and none of it is stored. The IDE shares its tabs between readers and
// remembers them across reloads because it is where work happens; this is a glance, and a glance
// that came back after a reload rearranged, or showed up rearranged for someone else, would be the
// surprise rather than the convenience.
//
// Nothing here asks on a timer. The tree and the open file are read again when `refresh` moves,
// which the caller ties to the Bot's pushed git status: that moves after every change git could
// report, which is every change to a file a reader here could be looking at.

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceTreeNode } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { ViewedFile } from "@/features/workspace-ide/editor/FilePreview";

export interface BotCode {
  /** Null until the first answer. */
  tree: WorkspaceTreeNode[] | null;
  openPath: string | null;
  /** The open file, or null while its first read is in flight. Kept across a re-read of itself. */
  file: ViewedFile | null;
  /** The last failure, of the tree or the file, or null since a good answer. */
  error: string | null;
  open(path: string): void;
  close(): void;
  toggle(path: string, expanded: boolean): void;
}

export function useBotCode(feed: SidecarDataSource, botId: string, refresh: unknown): BotCode {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [tree, setTree] = useState<WorkspaceTreeNode[] | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [file, setFile] = useState<ViewedFile | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // The tree stays on screen while the next one is read, so an expansion or a pushed change never
  // blanks the list the reader is pointing at.
  useEffect(() => {
    let current = true;
    feed.botTree(botId, expanded)
      .then((answer) => {
        if (!current) return;
        setTree(answer.tree);
        setTreeError(null);
      })
      .catch((cause: unknown) => {
        if (current) setTreeError(describe(cause, "Could not list the Bot's files."));
      });
    return () => {
      current = false;
    };
  }, [feed, botId, expanded, refresh]);

  // A different file clears the pane; the same file read again after a change does not.
  useEffect(() => {
    setFile((held) => (held?.path === openPath ? held : null));
    setFileError(null);
  }, [openPath]);

  useEffect(() => {
    if (openPath === null) return;
    let current = true;
    feed.botFile(botId, openPath)
      .then((answer) => {
        if (!current) return;
        setFile({ path: answer.path, kind: answer.kind, text: answer.text ?? "" });
        setFileError(null);
      })
      .catch((cause: unknown) => {
        if (current) setFileError(describe(cause, `Could not open ${openPath}.`));
      });
    return () => {
      current = false;
    };
  }, [feed, botId, openPath, refresh]);

  return {
    tree,
    openPath,
    file: file?.path === openPath ? file : null,
    error: fileError ?? treeError,
    open: setOpenPath,
    close: useCallback(() => setOpenPath(null), []),
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

function describe(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
