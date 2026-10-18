// A quick look into a Bot's directory: the folder viewer (`FolderCodeDialog`) over the Bot's own
// routes. The code button opens it on the files and the git button on the changes.

import { lazy, Suspense, useMemo } from "react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { FilePathTarget } from "@/features/activity-feed/markdown/filePathLinks";
import type { BotGitState } from "@/features/bots/git/useBotGitStatus";
import type { FolderSource } from "@/features/folder-code/folderSource";
import type { SidebarSection } from "@/features/workspace-ide/sidebar/SidebarSections";

// Loaded when a Bot's code is first opened rather than with the canvas: the folder viewer is the
// IDE's tree, editor and file previews, and a canvas that never opens one has no use for them.
const FolderCodeDialog = lazy(() =>
  import("@/features/folder-code/FolderCodeDialog").then((module) => ({ default: module.FolderCodeDialog })),
);

export function BotCodeDialog({
  bot,
  feed,
  git,
  initialSection,
  initialFile = null,
  onClose,
}: {
  bot: BotView;
  feed: SidecarDataSource;
  /** The card's git subscription: the changes list, and what makes the files re-read. */
  git: BotGitState;
  initialSection: SidebarSection;
  /** A file to open on, named in a session's transcript; its line is scrolled to and marked. */
  initialFile?: FilePathTarget | null;
  onClose: () => void;
}) {
  const { botId } = bot;
  const source = useMemo(
    (): FolderSource => ({
      key: `bot:${botId}`,
      tree: (expanded) => feed.botTree(botId, expanded),
      file: (path) => feed.botFile(botId, path),
      contentUrl: (path) => feed.botContentUrl(botId, path),
      gitDiff: (path) => feed.botGitDiff(botId, path),
    }),
    [feed, botId],
  );
  return (
    <Suspense fallback={null}>
      <FolderCodeDialog
        titleId="bot-code-title"
        title={bot.name}
        path={bot.environment.path}
        sectionsLabel="Bot sections"
        source={source}
        git={git}
        initialSection={initialSection}
        initialFile={initialFile}
        onClose={onClose}
      />
    </Suspense>
  );
}
