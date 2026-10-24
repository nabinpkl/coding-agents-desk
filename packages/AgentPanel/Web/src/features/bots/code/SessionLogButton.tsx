// A Bot session's agent log (ADR-0147), opened in the session's code viewer. Shown only on a session
// that has said it keeps one, through `tools/agent-log-register.sh`; every other session has none.

import { ScrollText } from "lucide-react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { FilePathTarget } from "@/features/activity-feed/markdown/filePathLinks";

/** The log this session keeps, relative to where it works, or null when it keeps none. */
export function sessionLogPath(bot: BotView, session: SessionSummary): string | null {
  return bot.sessionLogs?.[`${session.source}:${session.sessionId}`] ?? null;
}

/** In the session's controls row, beside its code button. */
export function SessionLogButton({
  bot,
  session,
  onOpen,
}: {
  bot: BotView;
  session: SessionSummary;
  onOpen: (file: FilePathTarget) => void;
}) {
  const path = sessionLogPath(bot, session);
  if (path === null) return null;
  const missing = bot.environmentAvailability === "missing";
  const label = `Read the log ${path.slice(path.lastIndexOf("/") + 1)} that ${session.title || session.sessionId} keeps`;
  return (
    <button
      type="button"
      onClick={() => onOpen({ path, line: null })}
      disabled={missing}
      aria-label={label}
      title={missing ? "Bot directory is unavailable" : label}
      className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg session-muted-ink outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <ScrollText className="size-4" aria-hidden />
    </button>
  );
}
