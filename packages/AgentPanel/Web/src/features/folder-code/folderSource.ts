// A folder the code viewer can read: a Bot's directory, an arena run's folder, a contestant's
// worktree. Each owner's routes name the folder by what it belongs to and answer the same shapes
// (`FolderTree` and the rest), so the viewer reads them all through this one seam.
//
// And what git says about that folder, as the sidecar sees it move: pushed, not polled. The
// sidecar watches the repository (`RepositoryGitWatch`, the same watch behind the IDE's source-
// control list) and sends a status after every change git could report. The subscription is
// dropped while the page is hidden, because a subscription is what makes the sidecar run git, and
// nobody is looking; coming back subscribes again and gets the status at once.

import type { FolderFileRead, FolderGitDiff, FolderGitStatus, FolderTree } from "@agentdesk/agent-feed-wire";
import { usePageVisible } from "@/hooks/dom/usePageVisible";
import { useStateFor } from "@/hooks/state/useStateFor";
import { useSubscription } from "@/hooks/useSubscription";
import { sourceKey } from "@/query/panelQuery";

export interface FolderSource {
  /** Names the folder among every other, so a diff read for one is never shown for another. */
  key: string;
  /** The folder with `expanded` listed beneath their parents: the whole set on every call. */
  tree(expanded: readonly string[]): Promise<FolderTree>;
  file(path: string): Promise<FolderFileRead>;
  /** Where a binary-backed file's bytes are fetched from, or null where the page cannot load one. */
  contentUrl(path: string): string | null;
  /** One path's uncommitted change, against `HEAD`. */
  gitDiff(path: string): Promise<FolderGitDiff>;
}

/** Follows the folder's git status; returns unsubscribe. */
export type FolderGitSubscribe<Status extends FolderGitStatus> = (
  onStatus: (status: Status) => void,
  onError: (reason: string) => void,
) => () => void;

export interface FolderGitState<Status extends FolderGitStatus = FolderGitStatus> {
  /** The last answer, or null before the first one arrives. */
  status: Status | null;
  /** Why the stream last failed, or null since the last good status. The status is kept either way. */
  error: string | null;
}

/**
 * `subscribe` is null for a folder with no git to ask, such as a Bot whose directory is missing.
 * A different `subscribe` is a different folder, so it starts over: keep it stable.
 */
export function useFolderGitStatus<Status extends FolderGitStatus>(
  subscribe: FolderGitSubscribe<Status> | null,
): FolderGitState<Status> {
  const [status, setStatus] = useStateFor<Status | null>(subscribe, () => null);
  const [error, setError] = useStateFor<string | null>(subscribe, () => null);
  const visible = usePageVisible();

  useSubscription(subscribe && visible ? `folder-git:${sourceKey(subscribe)}` : null, () =>
    subscribe?.((answer) => {
      setStatus(answer);
      setError(null);
    }, setError),
  );

  return { status, error };
}
