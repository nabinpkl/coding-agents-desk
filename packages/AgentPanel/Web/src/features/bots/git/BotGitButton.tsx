// The Bot header's git button: how many files in its directory are uncommitted, and the way in to
// what they are.
//
// Absent where there is no git to speak of -- a missing directory, one outside any repository, or
// before the first answer -- rather than drawn as a zero. A zero says "clean", and a Bot pointed at
// a plain folder is not clean, it has nothing to be clean about.

import { GitCompareArrows, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { BotGitDialog } from "@/features/bots/git/BotGitDialog";
import { useBotGitStatus } from "@/features/bots/git/useBotGitStatus";
import { changedFileCount, changedLabel } from "@/features/workspace-ide/sidebar/gitTones";

export function BotGitButton({ bot, feed }: { bot: BotView; feed: SidecarDataSource }) {
  const { status, error, refresh } = useBotGitStatus(
    feed,
    bot.botId,
    bot.environmentAvailability === "available",
  );
  const [open, setOpen] = useState(false);

  if (status === null && error === null) return null;
  if (status !== null && !status.repository) return null;

  const count = status === null ? 0 : changedFileCount(status.entries);
  // A read that failed with nothing to show yet has no dialog to open, so the button is the report:
  // the warning and the reason, where the count would have been.
  if (status === null) {
    return (
      <span
        role="img"
        aria-label={`Git changes unavailable: ${error}`}
        title={`Git changes unavailable: ${error}`}
        className="flex size-9 shrink-0 items-center justify-center text-destructive"
      >
        <TriangleAlert className="size-4" aria-hidden />
      </span>
    );
  }

  const label = count > 0 ? changedLabel(count) : "No uncommitted changes";
  return (
    <>
      <button
        type="button"
        onClick={() => {
          refresh();
          setOpen(true);
        }}
        aria-label={`Show git changes in ${bot.name}, ${label}`}
        title={error ? `${label}. Last read failed: ${error}` : label}
        className={`flex h-9 min-w-9 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg px-1.5 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70
          ${error ? "text-destructive" : "text-muted-foreground"}`}
      >
        <GitCompareArrows className="size-4" aria-hidden />
        {count > 0 ? (
          <span aria-hidden className="text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium tabular-nums">
            {count}
          </span>
        ) : null}
      </button>
      {open ? (
        <BotGitDialog
          bot={bot}
          feed={feed}
          status={status}
          error={error}
          onRefresh={refresh}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
