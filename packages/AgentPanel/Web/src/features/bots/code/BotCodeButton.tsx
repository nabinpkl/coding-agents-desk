// The Bot header's code button: the way into a quick, read-only look at the files in its directory.
//
// Present whenever the directory is, repository or not -- a plain folder has code to read too --
// and disabled, with the reason, when the directory is missing.

import { CodeXml } from "lucide-react";
import { useState } from "react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { BotCodeDialog } from "@/features/bots/code/BotCodeDialog";

export function BotCodeButton({
  bot,
  feed,
  refresh,
}: {
  bot: BotView;
  feed: SidecarDataSource;
  /** Anything that moves when the Bot's files do: the card passes its pushed git status. */
  refresh: unknown;
}) {
  const [open, setOpen] = useState(false);
  const missing = bot.environmentAvailability === "missing";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={missing}
        aria-label={`Browse the code in ${bot.name}`}
        title={missing ? "Bot directory is unavailable" : "Browse code"}
        className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <CodeXml className="size-4" aria-hidden />
      </button>
      {open ? (
        <BotCodeDialog bot={bot} feed={feed} refresh={refresh} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
