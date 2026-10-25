// A quick look into a Bot's directory: the folder viewer (`FolderCodeDialog`) over the Bot's own
// routes. The code button opens it on the files and the git button on the changes. Given a session
// working in a worktree of the Bot's checkout, it is a look into that worktree instead.

import { lazy, Suspense, useMemo } from "react";
import type { BotSessionRef, BotView } from "@agentdesk/agent-feed-wire";
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
  worktree,
  onClose,
}: {
  bot: BotView;
  feed: SidecarDataSource;
  /** The card's git subscription: the changes list, and what makes the files re-read. */
  git: BotGitState;
  initialSection: SidebarSection;
  /** A file to open on, named in a session's transcript; its line is scrolled to and marked. */
  initialFile?: FilePathTarget | null;
  /**
   * The session whose worktree this is a look into, with where that worktree is and its branch.
   * The git state handed in must then be the worktree's own (`useBotGitStatus` with the session).
   */
  worktree?: { session: BotSessionRef; path: string; branch: string | null };
  onClose: () => void;
}) {
  const { botId } = bot;
  // By the session's two strings, so a worktree object built afresh on each render is not a new folder.
  const sessionSource = worktree?.session.source;
  const sessionId = worktree?.session.sessionId;
  const source = useMemo((): FolderSource => {
    if (sessionSource === undefined || sessionId === undefined) {
      return {
        key: `bot:${botId}`,
        tree: (expanded) => feed.botTree(botId, expanded),
        file: (path) => feed.botFile(botId, path),
        contentUrl: (path) => feed.botContentUrl(botId, path),
        gitDiff: (path) => feed.botGitDiff(botId, path),
      };
    }
    const session: BotSessionRef = { source: sessionSource, sessionId };
    return {
      key: `bot:${botId}:${sessionSource}:${sessionId}`,
      tree: (expanded) => feed.botTree(botId, expanded, session),
      file: (path) => feed.botFile(botId, path, session),
      contentUrl: (path) => feed.botContentUrl(botId, path, session),
      gitDiff: (path) => feed.botGitDiff(botId, path, session),
    };
  }, [feed, botId, sessionSource, sessionId]);
  return (
    <Suspense fallback={null}>
      <FolderCodeDialog
        titleId="bot-code-title"
        title={worktree ? `${bot.name} · ${worktree.branch ?? "detached"}` : bot.name}
        path={worktree?.path ?? bot.environment.path}
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
