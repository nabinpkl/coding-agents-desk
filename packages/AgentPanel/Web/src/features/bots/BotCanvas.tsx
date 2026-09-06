import { Bot, ChevronDown, LoaderCircle, Plus } from "lucide-react";
import { useState } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { ActivityFeed } from "../activity-feed/ActivityFeed";
import type { EventMode } from "../activity-feed/data-source/AgentDataSource";
import { ActivityDot, SessionMeta } from "../sidebar/SessionMeta";
import { SourceBadge } from "../sidebar/SourceBadge";
import { BotAvatar } from "./BotSidebarPanel";
import { SessionRowMenu } from "./SessionRowMenu";

/**
 * How tall an opened transcript is inside its card.
 *
 * Bounded rather than natural: ActivityFeed owns its own scroller and virtualizes against it, so
 * it needs a height to scroll within. Tall enough to read a few turns, short enough that the card
 * above and below it stay reachable without scrolling the transcript first.
 */
const OPEN_TRANSCRIPT_HEIGHT = "h-[min(60dvh,520px)]";

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
  mode,
  onAddSession,
  onForkSession,
  onDetachSession,
  onAddBot,
}: {
  bots: BotView[];
  loading: boolean;
  error: string | null;
  /** Raw or nice, owned by the shell so the choice is the same one the Bots view reads in. */
  mode: EventMode;
  onAddSession: (bot: BotView) => void;
  /** Starts a new session branched from this one, in its own tmux pane. */
  onForkSession: (session: SessionSummary) => void;
  /**
   * Drops the reference from the Bot's projection. The session itself is untouched.
   *
   * Takes a reference rather than a summary because the rows that most need this are the ones with
   * no summary left: a transcript the catalog has forgotten shows as "missing" and would otherwise
   * be the one entry a Bot can never be rid of.
   */
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
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
    <BotCanvasList
      bots={bots}
      mode={mode}
      onAddSession={onAddSession}
      onForkSession={onForkSession}
      onDetachSession={onDetachSession}
    />
  );
}

/**
 * The roster, with at most one transcript open in it.
 *
 * One at a time rather than many, because an open transcript is an open SSE subscription and the
 * relay between this panel and the sidecar admits a bounded number of them -- the same budget that
 * collapsed the sidebar's per-project streams into one inventory stream. One open transcript costs
 * exactly what the single-thread view costs today, so a long roster cannot exhaust it. Two of them
 * would also be unreadable on a phone, where each is already most of the screen.
 */
function BotCanvasList({
  bots,
  mode,
  onAddSession,
  onForkSession,
  onDetachSession,
}: {
  bots: BotView[];
  mode: EventMode;
  onAddSession: (bot: BotView) => void;
  onForkSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <ul role="list" aria-label="Bot canvas" className="flex flex-col gap-3 p-3">
        {bots.map((bot) => (
          <BotCanvasCard
            key={bot.botId}
            bot={bot}
            mode={mode}
            openKey={openKey}
            onToggleSession={(key) => setOpenKey((current) => (current === key ? null : key))}
            onAddSession={onAddSession}
            onForkSession={onForkSession}
            onDetachSession={onDetachSession}
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
  mode,
  openKey,
  onToggleSession,
  onAddSession,
  onForkSession,
  onDetachSession,
}: {
  bot: BotView;
  mode: EventMode;
  openKey: string | null;
  onToggleSession: (key: string) => void;
  onAddSession: (bot: BotView) => void;
  onForkSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
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
        <button
          type="button"
          onClick={() => onAddSession(bot)}
          disabled={bot.environmentAvailability === "missing"}
          // Named for its Bot: a canvas of eight cards would otherwise give a screen reader eight
          // identically named buttons with no way to tell which card it is on.
          aria-label={`Add sessions to ${bot.name}`}
          title={bot.environmentAvailability === "missing" ? "Bot directory is unavailable" : "Add sessions"}
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden />
        </button>
      </div>

      {bot.sessions.length === 0 && bot.missingSessionRefs.length === 0 ? (
        <p className="px-3 py-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          No sessions attached
        </p>
      ) : (
        <ul role="list" aria-label={`${bot.name} sessions`}>
          {bot.sessions.map((session) => {
            const key = sessionKey(session);
            const open = key === openKey;
            return (
              <li key={key}>
                {/* A button cannot contain a button, so opening the transcript and opening the
                    row's menu are siblings and the open tint moves up to the box that holds
                    both -- the same shape the sidebar's rows took when they grew this menu. */}
                <div
                  className={`flex items-start border-l-2 pr-1.5 ${
                    open ? "border-primary bg-muted" : "border-transparent"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onToggleSession(key)}
                    aria-expanded={open}
                    className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-2 py-2 pr-2 pl-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
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
                    <ChevronDown
                      className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                      aria-hidden
                    />
                  </button>
                  <span className="mt-1">
                    <SessionRowMenu
                      label={session.title || session.sessionId}
                      onFork={() => onForkSession(session)}
                      onDetach={() => onDetachSession(bot, session)}
                    />
                  </span>
                </div>
                {open ? (
                  // Keyed by mode as well as session: every event index the feed holds is counted
                  // in the mode it was read in, so a mode change has to remount rather than
                  // reinterpret what is already in the buffer.
                  <div
                    className={`${OPEN_TRANSCRIPT_HEIGHT} border-t border-border bg-background`}
                    aria-label={`${session.title || session.sessionId} transcript`}
                  >
                    <ActivityFeed
                      key={`${session.sessionId}:${mode}`}
                      source={session.source}
                      sessionId={session.sessionId}
                      mode={mode}
                      onToggleMode={() => {}}
                      canToggleMode={false}
                      showCacheHits={false}
                      onToggleCacheHits={() => {}}
                      // No host: the feed's controls portal into the shell's header, and a card
                      // has no header to lend. Reading is what a card is for; the Bots view is
                      // where a thread gets its controls and its composer.
                      controlsHost={null}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
          {/* Shown rather than hidden: a curated reference whose transcript the catalog has
              forgotten is the row a reader most needs to see, and removing it is the Bots view's
              job, not this one's. */}
          {bot.missingSessionRefs.map((ref) => (
            <li
              key={sessionKey(ref)}
              className="flex min-h-9 items-center gap-2 py-1 pr-1.5 pl-3 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{ref.sessionId}</span>
              <SourceBadge source={ref.source} />
              <span>missing</span>
              <SessionRowMenu label={ref.sessionId} onDetach={() => onDetachSession(bot, ref)} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
