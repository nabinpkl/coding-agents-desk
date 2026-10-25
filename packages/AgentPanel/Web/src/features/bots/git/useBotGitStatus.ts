// What git says about a Bot's directory, or the worktree one of its sessions works in, as the
// sidecar sees it move: the folder viewer's own subscription (`useFolderGitStatus`), over the Bot's
// git stream.

import { useCallback } from "react";
import type { BotGitStatus, BotSessionRef } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useFolderGitStatus, type FolderGitState } from "@/features/folder-code/folderSource";

export type BotGitState = FolderGitState<BotGitStatus>;

export function useBotGitStatus(
  feed: SidecarDataSource,
  botId: string,
  /** False for a Bot whose directory is missing, which has no git to ask. */
  enabled: boolean,
  /** The session whose worktree to follow instead of the Bot's directory. */
  session?: BotSessionRef,
): BotGitState {
  // By its two strings rather than the object, which a caller may build afresh on every render: a
  // different `subscribe` is a different folder and starts over.
  const source = session?.source;
  const sessionId = session?.sessionId;
  const subscribe = useCallback(
    (onStatus: (status: BotGitStatus) => void, onError: (reason: string) => void) =>
      feed.subscribeBotGit(
        botId,
        onStatus,
        onError,
        source === undefined || sessionId === undefined ? undefined : { source, sessionId },
      ),
    [feed, botId, source, sessionId],
  );
  return useFolderGitStatus(enabled ? subscribe : null);
}
