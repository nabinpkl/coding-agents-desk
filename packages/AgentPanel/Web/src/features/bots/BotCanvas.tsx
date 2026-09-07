import { Bot, ChevronDown, LoaderCircle, Plus } from "lucide-react";
import { useState } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionView, type SessionViewContext } from "../session-view/SessionView";
import { ActivityDot, SessionMeta } from "../sidebar/SessionMeta";
import { SourceBadge } from "../sidebar/SourceBadge";
import { BotAvatar } from "./BotSidebarPanel";
import { SessionRowMenu } from "./SessionRowMenu";

/**
 * How tall an opened session is inside its card.
 *
 * Bounded rather than natural, because `SessionView` fills what it is given: it owns its own
 * scroller and everything inside it -- the transcript's virtualizer, the summary band's cap, the
 * terminal's share -- measures this box. Tall enough that a transcript is still readable once the
 * composer and its bands have taken their share, short enough that the cards above and below stay
 * reachable without scrolling a session first.
 */
const OPEN_SESSION_HEIGHT = "h-[min(75dvh,640px)]";

/**
 * Every Bot's curated sessions at once, in one scroll.
 *
 * The Bots view answers "what is this one Bot working on" and pays for it by making the other Bots
 * invisible: picking one is the only way to see anything, so comparing two means switching twice
 * and remembering the first. This is the same roster with that pick removed -- the reader scrolls
 * instead of switching, which is the whole point of it existing beside the tab it came from.
 *
 * The ROSTER costs nothing extra to serve. `/api/bots/stream` already resolves every curated
 * reference to a full catalog summary and republishes when the catalog moves, so every closed row
 * here is data the app is already holding for the sidebar: no second subscription, and no
 * per-session stream. That is what keeps a roster of thirty the same weight as a roster of three.
 *
 * An OPEN row is a different thing entirely: the whole session, the same component the app's own
 * thread view renders, with its transcript, its controls, its terminal and the composer it is typed
 * into. It is not a preview of a session, it is one -- which is why one is open at a time and why
 * closing it unmounts rather than hides it. See `BotCanvasList`.
 */
export function BotCanvas({
  bots,
  loading,
  error,
  sessionContext,
  botError,
  onAddSession,
  onForkSession,
  onDetachSession,
  onAddBot,
}: {
  bots: BotView[];
  loading: boolean;
  error: string | null;
  /**
   * Everything an opened row's session needs that is not the session, built once by the shell.
   * The same object the thread view is given, which is what makes a row here the same surface
   * rather than a lesser copy of it.
   */
  sessionContext: SessionViewContext;
  /**
   * A failure from editing a Bot, shown on the open session's own error band.
   *
   * This surface is where a detach is most likely to be pressed -- the action is in every row's
   * menu -- and the open session's band is the only one on screen able to say that one failed.
   */
  botError: string | null;
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
      sessionContext={sessionContext}
      botError={botError}
      onAddSession={onAddSession}
      onForkSession={onForkSession}
      onDetachSession={onDetachSession}
    />
  );
}

/**
 * The roster, with at most one session open in it.
 *
 * One at a time rather than many, and the reason got stronger when a row grew from a transcript
 * into a whole session. An open row is an event stream, a background-task stream, a summary probe
 * and a CLI-status poll -- and, once its terminal is opened, a pty attach. The relay between this
 * panel and the sidecar admits a bounded number of streams, the same budget that collapsed the
 * sidebar's per-project streams into one inventory stream. One open session costs exactly what the
 * single-thread view costs, so a roster of thirty cannot exhaust it. Two would also be unreadable
 * on a phone, where one is already most of the screen.
 *
 * Closing a row UNMOUNTS it rather than hiding it, which is what makes that true: every one of
 * those subscriptions belongs to a hook inside `SessionView`, so they end with it.
 */
function BotCanvasList({
  bots,
  sessionContext,
  botError,
  onAddSession,
  onForkSession,
  onDetachSession,
}: {
  bots: BotView[];
  sessionContext: SessionViewContext;
  botError: string | null;
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
            sessionContext={sessionContext}
            botError={botError}
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
  sessionContext,
  botError,
  openKey,
  onToggleSession,
  onAddSession,
  onForkSession,
  onDetachSession,
}: {
  bot: BotView;
  sessionContext: SessionViewContext;
  botError: string | null;
  openKey: string | null;
  onToggleSession: (key: string) => void;
  onAddSession: (bot: BotView) => void;
  onForkSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
}) {
  const projectName = bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path;
  const live = bot.sessions.filter((session) => session.activity === "live").length;
  // Where the open row's session portals its controls. One node per card is enough because one row
  // is open across the whole canvas; a card with none keeps null and is never asked for. State
  // rather than a ref, because the session has to re-render once the node exists.
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null);
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
                {/* A button cannot contain a button, so opening the session, its controls and its
                    menu are siblings and the open tint moves up to the box that holds them -- the
                    same shape the sidebar's rows took when they grew this menu. Open, this row is
                    the session's titlebar: it is where its controls land, the way the app header
                    is where the thread view's land. */}
                <div
                  className={`flex flex-wrap items-start border-l-2 pr-1.5 ${
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
                  {/* Its own line on a phone, inline once there is room. A session's controls are
                      five icons wide, which at 390px leaves the title about one character: the
                      name of the thing is worth more than keeping this to one line. `order-last`
                      rather than DOM order, so the menu stays beside the title where it is on
                      every closed row and does not move when one opens. */}
                  {open ? (
                    <span
                      ref={setControlsHost}
                      className="order-last mt-1 flex basis-full items-center justify-end gap-1 pb-1 sm:order-none sm:basis-auto sm:pb-0"
                    />
                  ) : null}
                  <span className="mt-1">
                    <SessionRowMenu
                      label={session.title || session.sessionId}
                      onFork={() => onForkSession(session)}
                      onDetach={() => onDetachSession(bot, session)}
                    />
                  </span>
                </div>
                {open ? (
                  // A named landmark rather than a bare box: a canvas of open cards is a page with
                  // several sessions on it, and each one should be reachable by name.
                  <section
                    className={`${OPEN_SESSION_HEIGHT} border-t border-border`}
                    aria-label={`${session.title || session.sessionId} session`}
                  >
                    {/* The same component the app's own thread view renders, given a box instead
                        of the page. It needs nothing said to it about being small: everything in
                        it measures the column it is, so the box decides. */}
                    <SessionView
                      {...sessionContext}
                      projectPath={bot.environment.path}
                      session={session}
                      controlsHost={controlsHost}
                      externalError={botError}
                    />
                  </section>
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
