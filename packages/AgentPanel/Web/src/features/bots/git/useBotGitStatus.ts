// What git says about a Bot's directory, as the sidecar sees it move: the folder viewer's own
// subscription (`useFolderGitStatus`), over the Bot's git stream.

import { useCallback } from "react";
import type { BotGitStatus } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useFolderGitStatus, type FolderGitState } from "@/features/folder-code/folderSource";

export type BotGitState = FolderGitState<BotGitStatus>;

export function useBotGitStatus(
  feed: SidecarDataSource,
  botId: string,
  /** False for a Bot whose directory is missing, which has no git to ask. */
  enabled: boolean,
): BotGitState {
  const subscribe = useCallback(
    (onStatus: (status: BotGitStatus) => void, onError: (reason: string) => void) =>
      feed.subscribeBotGit(botId, onStatus, onError),
    [feed, botId],
  );
  return useFolderGitStatus(enabled ? subscribe : null);
}
