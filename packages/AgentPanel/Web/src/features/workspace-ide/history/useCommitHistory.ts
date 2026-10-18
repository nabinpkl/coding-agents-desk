// The history's reading position, kept outside the popup that draws it.
//
// The popup is unmounted every time it is dismissed -- Escape, or a pointer landing outside both
// the status bar and the editor. If the state lived in it, each of those would also throw away the
// log and the commit the reader had expanded, so coming back to a commit they were in the middle of
// would mean scrolling and re-expanding every time. It lives on the status bar instead, which never
// unmounts, and the popup is handed it.
//
// Nothing here is stored: which commit a reader had open is a position in a session, not an
// arrangement of the panel, and a popup that reopened three days later on a commit that has since
// been rebased away would be remembering the wrong thing (AGENTS.md, on what earns storage).

import { useCallback, useState } from "react";
import type { WorkspaceCommit, WorkspaceCommitDetail } from "@agentdesk/agent-feed-wire";
import type { WorkspaceIdeClient } from "@/features/workspace-ide/workspaceIdeClient";
import { queryFailure, sourceKey, usePanelQuery } from "@/query/panelQuery";

/** How many commits arrive at a time, and how many each "Show more" adds. */
export const PAGE = 50;

export interface CommitHistory {
  /** Null until the first answer, which is what the popup draws as "reading". */
  commits: WorkspaceCommit[] | null;
  failure: string | null;
  /** How many were asked for, so the popup knows whether there may be more. */
  limit: number;
  /** The one expanded commit, if any. One at a time: see the popup for why. */
  openHash: string | null;
  /** Its message and files, once they arrive. Cached by hash, so re-expanding is free. */
  details: Record<string, WorkspaceCommitDetail>;
  toggleCommit(hash: string): void;
  showMore(): void;
}

/** Where the reader is in one workspace's log. */
interface Position {
  workspaceId: string | null;
  limit: number;
  openHash: string | null;
}

/**
 * The log, and one commit's files.
 *
 * `enabled` is what keeps a reader who never opens the history from paying for it: the status bar
 * calls this on every render of every workspace, and the first fetch waits for the popup to have
 * been opened once.
 */
export function useCommitHistory(
  client: WorkspaceIdeClient,
  workspaceId: string | null,
  enabled: boolean,
): CommitHistory {
  // A commit is a fact about one repository, so the position belongs to the workspace it was taken
  // in, and a switch starts from the top. Both reads are keyed on the workspace for the same reason:
  // the last project's log must never draw under this project's branch.
  const [held, setPosition] = useState<Position>({ workspaceId, limit: PAGE, openHash: null });
  const position: Position = held.workspaceId === workspaceId ? held : { workspaceId, limit: PAGE, openHash: null };
  const { limit, openHash } = position;
  const clientKey = sourceKey(client);

  const log = usePanelQuery({
    queryKey: ["workspace-commits", clientKey, workspaceId, limit],
    queryFn: () => client.commits(workspaceId!, limit).then((answer) => answer.commits),
    enabled: enabled && workspaceId !== null,
    // "Show more" asks again with a longer limit; the shorter log stays on screen meanwhile.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === workspaceId ? previous : undefined),
  });
  const detail = usePanelQuery({
    queryKey: ["workspace-commit", clientKey, workspaceId, openHash],
    queryFn: () => client.commit(workspaceId!, openHash!).then((answer) => answer.detail),
    enabled: openHash !== null && workspaceId !== null,
    // A commit's files never change under its hash, so re-expanding one is free.
    staleTime: Infinity,
  });

  const details: Record<string, WorkspaceCommitDetail> =
    openHash !== null && detail.data ? { [openHash]: detail.data } : {};
  const failure = log.error
    ? `Could not read the history: ${queryFailure(log.error)}`
    : detail.error
      ? `Could not read that commit: ${queryFailure(detail.error)}`
      : null;

  const toggleCommit = useCallback(
    (hash: string) =>
      setPosition((current) => {
        const base = current.workspaceId === workspaceId ? current : { workspaceId, limit: PAGE, openHash: null };
        return { ...base, openHash: base.openHash === hash ? null : hash };
      }),
    [workspaceId],
  );
  const showMore = useCallback(
    () =>
      setPosition((current) => {
        const base = current.workspaceId === workspaceId ? current : { workspaceId, limit: PAGE, openHash: null };
        return { ...base, limit: base.limit + PAGE };
      }),
    [workspaceId],
  );

  return {
    commits: log.data ?? null,
    failure,
    limit,
    openHash,
    details,
    toggleCommit,
    showMore,
  };
}
