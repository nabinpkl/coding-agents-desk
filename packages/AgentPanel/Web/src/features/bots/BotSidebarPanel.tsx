import { Bot, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SourceBadge } from "../sidebar/SourceBadge";

export function BotAvatar({ bot, size = "size-10" }: { bot: Pick<BotView, "name" | "iconUrl">; size?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [bot.iconUrl]);
  const initials = bot.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "B";
  if (bot.iconUrl && !failed) {
    return (
      <img
        src={bot.iconUrl}
        alt=""
        className={`${size} shrink-0 rounded-full border border-border object-cover`}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded-full border border-border bg-muted font-semibold text-foreground`}
    >
      {initials}
    </span>
  );
}

function attachedSessionKey(session: BotSessionRef): string {
  return `${session.source}:${session.sessionId}`;
}

export function BotSidebarPanel({
  bots,
  loading,
  error,
  selectedBotId,
  selectedSessionKey,
  onSelectSession,
  onAddSession,
  onAddBot,
}: {
  bots: BotView[];
  loading: boolean;
  error: string | null;
  selectedBotId: string | null;
  selectedSessionKey: string | null;
  onSelectSession: (bot: BotView, session: SessionSummary) => void;
  onAddSession: (bot: BotView) => void;
  onAddBot: () => void;
}) {
  return (
    <div className="min-h-0">
      <button
        type="button"
        onClick={onAddBot}
        className="flex min-h-11 w-full cursor-pointer items-center gap-2 border-b border-border px-3 text-left text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-primary/15"
      >
        <Plus className="size-4" aria-hidden />
        Add Bot
      </button>
      {loading ? (
        <div role="status" className="flex min-h-28 items-center justify-center gap-2 p-4 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden />
          Loading Bots…
        </div>
      ) : error ? (
        <div role="alert" className="p-4 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
          Bots unavailable: {error}
        </div>
      ) : bots.length === 0 ? (
        <div role="status" className="flex min-h-28 flex-col items-center justify-center gap-2 p-4 text-center text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          <Bot className="size-5" aria-hidden />
          No bots yet
        </div>
      ) : (
        <ul role="list" aria-label="Bots">
          {bots.map((bot) => {
            const projectName = bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path;
            const selected = bot.botId === selectedBotId;
            return (
              <li key={bot.botId} className="border-b border-border/80">
                <div className={`flex min-h-16 items-center gap-3 border-l-2 px-3 py-2 ${selected ? "border-primary bg-muted" : "border-transparent"}`}>
                  <BotAvatar bot={bot} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-semibold text-foreground">
                      {bot.name}
                    </span>
                    {bot.metadata.role ? (
                      <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
                        {bot.metadata.role}
                      </span>
                    ) : null}
                    <span className="mt-0.5 block truncate font-mono text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
                      {projectName}
                      {bot.environmentAvailability === "missing" ? " · missing directory" : ""}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onAddSession(bot)}
                    disabled={bot.environmentAvailability === "missing"}
                    aria-label={`Add sessions to ${bot.name}`}
                    title={bot.environmentAvailability === "missing" ? "Bot directory is unavailable" : "Add sessions"}
                    className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-background/70 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="size-4" aria-hidden />
                  </button>
                </div>

                {bot.sessions.length > 0 || bot.missingSessionRefs.length > 0 ? (
                  <ul role="list" aria-label={`${bot.name} sessions`} className="pb-1">
                    {bot.sessions.map((session) => {
                      const key = attachedSessionKey(session);
                      const active = selected && selectedSessionKey === key;
                      return (
                        <li key={key}>
                          <button
                            type="button"
                            onClick={() => onSelectSession(bot, session)}
                            aria-current={active ? "page" : undefined}
                            className={`flex min-h-10 w-full cursor-pointer items-center gap-2 py-1.5 pr-3 pl-14 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80 ${active ? "bg-muted text-foreground" : "text-foreground"}`}
                          >
                            <span className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-meta,13px)">
                              {session.title || session.sessionId}
                            </span>
                            <SourceBadge source={session.source} />
                            {!session.capabilities.canSend ? <span className="text-[11px] text-muted-foreground">view only</span> : null}
                          </button>
                        </li>
                      );
                    })}
                    {bot.missingSessionRefs.map((ref) => (
                      <li key={attachedSessionKey(ref)} className="flex min-h-9 items-center gap-2 py-1 pr-3 pl-14 text-xs text-muted-foreground">
                        <span className="min-w-0 flex-1 truncate">{ref.sessionId}</span>
                        <SourceBadge source={ref.source} />
                        <span>missing</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="pb-2 pr-3 pl-14 text-xs text-muted-foreground">No sessions attached</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
