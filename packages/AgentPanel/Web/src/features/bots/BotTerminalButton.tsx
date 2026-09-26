// The Bot header's terminal button: the same shell dialog the machine terminal opens, pointed at
// the Bot's own directory instead of the machine's home.
//
// A `tmux-new` shell rather than a workspace one: the workspace kind rides the PTY manager, which
// a peer running the sidecar alone does not have, while tmux is already there on every machine.
// One fixed session per Bot, so a second reader joins the shell the first one opened instead of
// starting a second in the same directory. Closing ends it, the way closing the machine shell
// ends that one.

import { Terminal } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentTerminalContext, BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { TerminalShellDialog } from "@/features/terminal/MachineTerminalDialog";

/** The tmux session a Bot's directory shell runs in. Shared so the button and the dialog name one. */
export function botTerminalSession(botId: string): string {
  return `agent-bot-${botId}`;
}

export function BotTerminalButton({
  bot,
  feed,
}: {
  bot: BotView;
  /** The sidecar that owns this Bot's directory, which is where the shell lands. */
  feed: SidecarDataSource;
}) {
  const [open, setOpen] = useState(false);
  const missing = bot.environmentAvailability === "missing";
  const session = botTerminalSession(bot.botId);
  // Stable by identity: the hook tears the terminal down and re-attaches when this changes, so a
  // fresh object every render would do that on every render.
  const context = useMemo<AgentTerminalContext>(
    () => ({ kind: "tmux-new", session, directory: bot.environment.path }),
    [session, bot.environment.path],
  );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={missing}
        aria-label={`Open a terminal in ${bot.name}`}
        title={missing ? "Bot directory is unavailable" : "Open terminal"}
        className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Terminal className="size-4" aria-hidden />
      </button>
      {open ? (
        <TerminalShellDialog
          feed={feed}
          context={context}
          title={`Terminal in ${bot.name}`}
          where={bot.environment.path}
          onClose={() => setOpen(false)}
          onEnd={async (endFeed) => {
            await endFeed.killTmuxSession(session);
            return true;
          }}
        />
      ) : null}
    </>
  );
}
