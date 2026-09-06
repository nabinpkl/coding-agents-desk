import { Bot, LoaderCircle, Plus } from "lucide-react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { ActivityDot, SessionMeta } from "../sidebar/SessionMeta";
import { SourceBadge } from "../sidebar/SourceBadge";
import { BotAvatar } from "./BotSidebarPanel";

/**
 * Every Bot's curated sessions at once, in one scroll.
 *
 * The Bots view answers "what is this one Bot working on" and pays for it by making the other Bots
 * invisible: picking one is the only way to see anything, so comparing two means switching twice
 * and remembering the first. This is the same roster with that pick removed -- the reader scrolls
 * instead of switching, which is the whole point of it existing beside the tab it came from.
 *
 * It costs nothing extra to serve. `/api/bots/stream` already resolves every curated reference to
 * a full catalog summary and republishes when the catalog moves, so this renders data the app is
 * already holding for the sidebar: no second subscription, and no per-session stream. That last
 * part is what keeps a roster of thirty sessions the same weight as a roster of three, and it is
 * the property to check before a row here grows a live transcript preview.
 */
export function BotCanvas({
  bots,
  loading,
  error,
  selectedSessionKey,
  onOpenSession,
  onAddBot,
}: {
  bots: BotView[];
  loading: boolean;
  error: string | null;
  selectedSessionKey: string | null;
  onOpenSession: (bot: BotView, session: SessionSummary) => void;
  onAddBot: () => void;
}) {
  if (loading) {
    return (
      <CanvasNotice>
        <LoaderCircle className="size-4 animate-spin" aria-hidden />
        Loading Bots…
      </CanvasNotice>
    );
  }
  if (error) {
    return (
      <div role="alert" className="flex h-full items-center justify-center p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-destructive">
        Bots unavailable: {error}
      </div>
    );
  }
  if (bots.length === 0) {
    return (
      <CanvasNotice>
        <Bot className="size-5" aria-hidden />
        <span>No bots yet</span>
        <button
          type="button"
          onClick={onAddBot}
          className="mt-1 flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-primary outline-none transition-colors hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-primary active:bg-primary/15"
        >
          <Plus className="size-4" aria-hidden />
          Add Bot
        </button>
      </CanvasNotice>
    );
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <ul role="list" aria-label="Bot canvas" className="flex flex-col gap-3 p-3">
        {bots.map((bot) => (
          <BotCanvasCard
            key={bot.botId}
            bot={bot}
            selectedSessionKey={selectedSessionKey}
            onOpenSession={onOpenSession}
          />
        ))}
      </ul>
    </div>
  );
}

function CanvasNotice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground"
    >
      {children}
    </div>
  );
}

function sessionKey(session: BotSessionRef): string {
  return `${session.source}:${session.sessionId}`;
}

function BotCanvasCard({
  bot,
  selectedSessionKey,
  onOpenSession,
}: {
  bot: BotView;
  selectedSessionKey: string | null;
  onOpenSession: (bot: BotView, session: SessionSummary) => void;
}) {
  const projectName = bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path;
  const live = bot.sessions.filter((session) => session.activity === "live").length;
  return (
    <li className="overflow-hidden rounded-xl border border-border bg-card">
      {/* Sticky so the name of whichever Bot you are reading stays overhead through a long
          roster. The canvas is one scroller, not one per card, so this is the only thing that
          says which Bot the rows under the fold belong to. */}
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-card px-3 py-2">
        <BotAvatar bot={bot} size="size-9" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-semibold text-foreground">
            {bot.name}
          </span>
          <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            {bot.metadata.role ? `${bot.metadata.role} · ` : ""}
            <span className="font-mono">{projectName}</span>
            {bot.environmentAvailability === "missing" ? " · missing directory" : ""}
          </span>
        </span>
        <span className="shrink-0 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
          {live > 0 ? `${live} live · ` : ""}
          {bot.sessions.length} {bot.sessions.length === 1 ? "session" : "sessions"}
        </span>
      </div>

      {bot.sessions.length === 0 && bot.missingSessionRefs.length === 0 ? (
        <p className="px-3 py-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          No sessions attached
        </p>
      ) : (
        <ul role="list" aria-label={`${bot.name} sessions`}>
          {bot.sessions.map((session) => {
            const key = sessionKey(session);
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => onOpenSession(bot, session)}
                  aria-current={key === selectedSessionKey ? "page" : undefined}
                  className={`flex min-h-11 w-full cursor-pointer items-start gap-2 border-l-2 px-3 py-2 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80 ${
                    key === selectedSessionKey ? "border-primary bg-muted" : "border-transparent"
                  }`}
                >
                  <ActivityDot activity={session.activity} className="mt-1.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
                      {session.title || session.sessionId}
                    </span>
                    <SessionMeta
                      source={session.source}
                      lastEventAt={session.lastEventAt}
                      activity={session.activity}
                    />
                  </span>
                  {!session.capabilities.canSend ? (
                    <span className="mt-0.5 shrink-0 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
                      view only
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
          {/* Shown rather than hidden: a curated reference whose transcript the catalog has
              forgotten is the row a reader most needs to see, and removing it is the Bots view's
              job, not this one's. */}
          {bot.missingSessionRefs.map((ref) => (
            <li
              key={sessionKey(ref)}
              className="flex min-h-9 items-center gap-2 px-3 py-2 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{ref.sessionId}</span>
              <SourceBadge source={ref.source} />
              <span>missing</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
