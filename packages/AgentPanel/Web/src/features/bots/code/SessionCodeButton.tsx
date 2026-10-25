// A Bot's session card's way into its code: the folder viewer the Bot's header opens, on the
// Bot's directory, or on the worktree the session works in when it is in one, since that is where
// its changes are. The card holds whether it is open (`useSessionCode`).

import { CodeXml } from "lucide-react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { FilePathTarget } from "@/features/activity-feed/markdown/filePathLinks";
import { BotCodeDialog } from "@/features/bots/code/BotCodeDialog";
import { useBotGitStatus } from "@/features/bots/git/useBotGitStatus";

/** In the session's controls row, beside its terminal. */
export function SessionCodeButton({
  bot,
  session,
  onOpen,
}: {
  bot: BotView;
  session: SessionSummary;
  onOpen: () => void;
}) {
  const missing = bot.environmentAvailability === "missing";
  // Named for the session, not the Bot: the Bot's header carries a code button of its own, and two
  // buttons of one name on one card cannot be told apart by a screen reader.
  const title = session.title || session.sessionId;
  const label = session.worktree
    ? `Browse the code for ${title}, in the ${session.worktree.branch ?? "detached"} worktree`
    : `Browse the code for ${title}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={missing}
      aria-label={label}
      title={missing ? "Bot directory is unavailable" : label}
      className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg session-muted-ink outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <CodeXml className="size-4" aria-hidden />
    </button>
  );
}

/**
 * The viewer itself, with a git subscription of its own while it is open: the Bot card's follows
 * the Bot's directory, which is the wrong repository state for a worktree.
 */
export function SessionCodeDialog({
  bot,
  feed,
  session,
  file,
  onClose,
}: {
  bot: BotView;
  feed: SidecarDataSource;
  session: SessionSummary;
  file: FilePathTarget | null;
  onClose: () => void;
}) {
  const worktree = session.worktree;
  const ref = worktree ? { source: session.source, sessionId: session.sessionId } : undefined;
  const git = useBotGitStatus(feed, bot.botId, bot.environmentAvailability === "available", ref);
  return (
    <BotCodeDialog
      bot={bot}
      feed={feed}
      git={git}
      initialSection="explorer"
      initialFile={file}
      {...(worktree && ref ? { worktree: { session: ref, path: worktree.path, branch: worktree.branch } } : {})}
      onClose={onClose}
    />
  );
}
