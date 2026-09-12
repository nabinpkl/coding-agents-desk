import { Bot, ChevronDown, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionView, type SessionViewContext } from "../session-view/SessionView";
import { ActivityDot, SessionMeta } from "../sidebar/SessionMeta";
import { SourceBadge } from "../sidebar/SourceBadge";
import { BotAvatar } from "./BotSidebarPanel";
import {
  CAROUSEL_CANVAS_WIDTH,
  DEFAULT_CARD_SIZE,
  MAX_CARD_HEIGHT,
  MAX_CARD_WIDTH,
  MIN_CARD_HEIGHT,
  MIN_CARD_WIDTH,
  clampCardHeight,
  clampCardWidth,
  loadBotCardSizes,
  storeBotCardSizes,
  type BotCardSize,
  type BotCardSizes,
} from "./botCanvasPreferences";
import { BotCardMenu } from "./BotCardMenu";
import { SessionRowMenu } from "./SessionRowMenu";

/**
 * The Bots put on the canvas, with all of their curated sessions, in one scroll.
 *
 * The Bots view answers "what is this one Bot working on" and pays for it by making the other Bots
 * invisible: picking one is the only way to see anything, so comparing two means switching twice
 * and remembering the first. This is the same roster with that pick removed -- the reader scrolls
 * instead of switching, which is the whole point of it existing beside the tab it came from.
 *
 * All of them by default, and any of them can be taken off. Which ones are on is decided by the
 * sidebar's roster and passed in already filtered; this component is handed a list of Bots and
 * shows exactly those.
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
  onDetachBot,
  detachedCount,
  openKey,
  onToggleSession,
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
  /**
   * Takes the whole Bot off this canvas. The Bot, its curated sessions and their transcripts are
   * untouched -- this arranges the view, and the sidebar's canvas panel is where it waits to come
   * back.
   */
  onDetachBot: (bot: BotView) => void;
  /**
   * How many Bots exist but are off the canvas, which is only ever asked when `bots` is empty. An
   * empty canvas that says "No bots yet" over a roster of eight is a lie, and would send the reader
   * to Add Bot rather than to the roster their Bots are already in.
   */
  detachedCount: number;
  /**
   * Which session is open, as `source:sessionId`, owned above this component.
   *
   * It used to live in `BotCanvasList`, and it moved out when the sidebar beside the canvas gained
   * the same rows: a session picked over there opens the card over here, which cannot work while
   * the only copy of the answer is inside the thing being driven.
   */
  openKey: string | null;
  /** Opens that session, or closes it if it is the one already open. */
  onToggleSession: (key: string) => void;
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
        <span>
          {detachedCount > 0
            ? `No Bots on the canvas. Put one on from the roster in the sidebar.`
            : "No bots yet"}
        </span>
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
      onDetachBot={onDetachBot}
      openKey={openKey}
      onToggleSession={onToggleSession}
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
  onDetachBot,
  openKey,
  onToggleSession,
}: {
  bots: BotView[];
  sessionContext: SessionViewContext;
  botError: string | null;
  onAddSession: (bot: BotView) => void;
  onForkSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  onDetachBot: (bot: BotView) => void;
  openKey: string | null;
  onToggleSession: (key: string) => void;
}) {
  // Every Bot's card size, read once at mount and written on release rather than on every pointer
  // move, so a drag is one storage write.
  const [sizes, setSizes] = useState<BotCardSizes>(loadBotCardSizes);
  // How wide the canvas is. It no longer bounds a card -- the strip scrolls, so a card may be wider
  // than the panel -- and is measured for one question only: whether there is room to put two cards
  // side by side at all. Measured rather than queried, because the sidebar is pinnable and
  // resizable, so the window's width is not this panel's. The SCROLLER is what gets measured, not
  // the list inside it: the list is `w-max`, so it reports its own contents, and widening a card
  // would grow the very thing being asked how much room a card has.
  const canvas = useRef<HTMLDivElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  useEffect(() => {
    const node = canvas.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    // The list's own padding is not room a card can use.
    const measure = (): void => setCanvasWidth(Math.max(0, node.clientWidth - 24));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const resize = (botId: string, size: BotCardSize, keep: boolean): void => {
    const next = { ...sizes, [botId]: size };
    setSizes(next);
    if (keep) storeBotCardSizes(next);
  };
  return (
    <div ref={canvas} className="h-full overflow-auto overscroll-contain">
      {/* One strip, and nothing wraps out of it. A card widened here takes the room and pushes the
          cards after it along; none of them can drop to a line below, because there is no line
          below. That is the whole difference from the grid this replaced, and it is why the canvas
          scrolls sideways rather than being capped to fit.

          `items-start` because a card is as tall as its own roster: without it every card stretches
          to the tallest, so a Bot with two sessions beside a Bot with twelve becomes a card mostly
          made of empty. The cost is a ragged bottom edge, which is the honest shape of a row that
          holds different amounts. */}
      <ul role="list" aria-label="Bot canvas" className="flex w-max items-start gap-3 p-3">
        {bots.map((bot) => (
          <BotCanvasCard
            key={bot.botId}
            bot={bot}
            sessionContext={sessionContext}
            botError={botError}
            openKey={openKey}
            onToggleSession={onToggleSession}
            size={sizes[bot.botId] ?? DEFAULT_CARD_SIZE}
            carouselWidth={
              canvasWidth > 0 && canvasWidth < CAROUSEL_CANVAS_WIDTH ? canvasWidth : null
            }
            onResize={(size) => resize(bot.botId, size, false)}
            onResizeCommit={(size) => resize(bot.botId, size, true)}
            onAddSession={onAddSession}
            onForkSession={onForkSession}
            onDetachSession={onDetachSession}
            onDetachBot={onDetachBot}
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
  size,
  carouselWidth,
  onResize,
  onResizeCommit,
  onAddSession,
  onForkSession,
  onDetachSession,
  onDetachBot,
}: {
  bot: BotView;
  sessionContext: SessionViewContext;
  botError: string | null;
  openKey: string | null;
  onToggleSession: (key: string) => void;
  size: BotCardSize;
  /**
   * The width to show every card at when the canvas is too narrow to hold two, and null when it is
   * not. Display only: it is never written back, so a phone cannot overwrite the width this Bot was
   * given on a Mac.
   */
  carouselWidth: number | null;
  /** Live during a drag, so the card follows the pointer. Not written to storage. */
  onResize: (size: BotCardSize) => void;
  /** The size to keep, on pointer release or a key press. */
  onResizeCommit: (size: BotCardSize) => void;
  onAddSession: (bot: BotView) => void;
  onForkSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  onDetachBot: (bot: BotView) => void;
}) {
  const projectName = bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path;
  const live = bot.sessions.filter((session) => session.activity === "live").length;
  // Where the open row's session portals its controls. One node per card is enough because one row
  // is open across the whole canvas; a card with none keeps null and is never asked for. State
  // rather than a ref, because the session has to re-render once the node exists.
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null);
  // Whether the open session is one of THIS card's, which is what makes this card the sized one.
  const holdsOpen = openKey !== null && bot.sessions.some((session) => sessionKey(session) === openKey);
  // Brings this card into view when it becomes the open one, because the row that opened it may
  // have been in the sidebar rather than on the canvas, and the card can be anywhere in a tiled
  // roster of thirty. `nearest` rather than `start`: it does nothing at all when the card is
  // already fully visible, which is the common case of clicking a row on the canvas itself, and a
  // card taller than the scroller aligns to its top under the same rule.
  const card = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (!holdsOpen) return;
    card.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [holdsOpen]);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; from: BotCardSize } | null>(null);

  // The room each edge has to move in. Width is held to the row this card sits in; height is held
  // only away from the two ends of its own range, and in particular not to the window -- a card
  // taller than the screen is a card you asked to see more of at once, and the canvas scrolls.
  // Asked with a finite maximum rather than `Infinity`, which the clamps read as a number they
  // cannot trust and answer with the default.
  const widthWithin = (width: number): number => clampCardWidth(width);
  const heightWithin = (height: number): number => clampCardHeight(height);
  const widest = (): number => widthWithin(MAX_CARD_WIDTH);
  const tallest = (): number => heightWithin(MAX_CARD_HEIGHT);
  // What this card actually stands at: the remembered size held inside THIS canvas and window. A
  // size saved on a bigger screen would otherwise be reported as the card's while CSS quietly drew
  // it smaller, and a drag would then start from a number the card was never at.
  const width = carouselWidth ?? widthWithin(size.width);
  const height = heightWithin(size.height);
  const commit = (next: Partial<BotCardSize>): void =>
    onResizeCommit({
      // The card's OWN width while the canvas is showing it at the carousel's, so releasing a
      // height drag on a phone does not quietly store the phone's width over it.
      width: carouselWidth === null ? widthWithin(next.width ?? width) : size.width,
      height: heightWithin(next.height ?? height),
    });
  const resizeFromKeyboard = (event: React.KeyboardEvent<HTMLDivElement>, axis: "width" | "height"): void => {
    const along = axis === "width"
      ? { less: "ArrowLeft", more: "ArrowRight", at: width, floor: MIN_CARD_WIDTH, ceiling: widest() }
      : { less: "ArrowUp", more: "ArrowDown", at: height, floor: MIN_CARD_HEIGHT, ceiling: tallest() };
    let next: number | null = null;
    if (event.key === along.more) next = along.at + 24;
    else if (event.key === along.less) next = along.at - 24;
    else if (event.key === "Home") next = along.floor;
    else if (event.key === "End") next = along.ceiling;
    if (next === null) return;
    event.preventDefault();
    commit({ [axis]: next });
  };
  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: { width, height },
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const dragTo = (event: React.PointerEvent<HTMLDivElement>, axes: { width?: boolean; height?: boolean }): void => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    // Right and down grow the card, which is the direction the edge under the pointer is moving.
    onResize({
      width: axes.width
        ? widthWithin(active.from.width + event.clientX - active.startX)
        : width,
      height: axes.height
        ? heightWithin(active.from.height + event.clientY - active.startY)
        : height,
    });
  };
  const finishDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    // Kept before the release, because releasing a capture the browser never granted throws and
    // would otherwise take the whole drag's result with it.
    commit({});
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  return (
    // Width always, height only while it holds the open session: closed, a card is as tall as its
    // own roster and a remembered height would be empty space. The card is a ROW -- its content
    // beside the strip that widens it -- because the card clips its own overflow, so a handle
    // hanging off the border would not be there to grab, and one overlaid on the inside edge would
    // land on the transcript's scrollbar.
    <li
      ref={card}
      className="flex shrink-0 overflow-hidden rounded-xl border border-border bg-card"
      style={{ width }}
    >
      <div
        className="flex min-w-0 flex-1 flex-col"
        style={holdsOpen ? { height } : undefined}
      >
        {/* Not sticky, and it never was in effect. It carried `sticky top-0` from the days of a
            single scrolling column, but the card clips its own overflow, which makes the CARD the
            scrollport this would stick inside -- and a card never scrolls. Measured: with the
            card's top 288px above the scroller's top, the header sat at the card's top, not the
            scroller's. */}
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-3 py-2">
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
          {/* Beside the add button rather than in it: one adds sessions to the Bot, the other
              takes the whole Bot off the canvas, and they are not the same scale of act. */}
          <BotCardMenu bot={bot} onDetach={() => onDetachBot(bot)} />
        </div>

        {bot.sessions.length === 0 && bot.missingSessionRefs.length === 0 ? (
          <p className="px-3 py-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            No sessions attached
          </p>
        ) : (
          // The one flexible thing in the card: closed rows keep their own height, so a drag lands
          // entirely on the open session. Squeezed hard enough the session collapses to nothing and
          // the roster stays readable, which is the recoverable way round -- drag it taller again.
          <ul role="list" aria-label={`${bot.name} sessions`} className="flex min-h-0 flex-1 flex-col">
            {bot.sessions.map((session) => {
              const key = sessionKey(session);
              const open = key === openKey;
              return (
                <li key={key} className={open ? "flex min-h-0 flex-1 flex-col" : "shrink-0"}>
                  {/* A button cannot contain a button, so opening the session, its controls and its
                      menu are siblings and the open tint moves up to the box that holds them -- the
                      same shape the sidebar's rows took when they grew this menu. Open, this row is
                      the session's titlebar: it is where its controls land, the way the app header
                      is where the thread view's land. */}
                  <div
                    className={`@container flex shrink-0 flex-wrap items-start border-l-2 pr-1.5 ${
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
                    {/* Its own line in a narrow row, inline once there is room. A session's controls
                        are five icons wide, which in a grid column leaves the title about one
                        character: the name of the thing is worth more than keeping this to one line.
                        `order-last` rather than DOM order, so the menu stays beside the title where
                        it is on every closed row and does not move when one opens.

                        The query is on this ROW, not the viewport. A `sm:` breakpoint asks how wide
                        the window is, and a grid column on a wide Mac is narrower than a phone: it
                        kept the controls inline in a 451px column and truncated the title to "CPU
                        and RA...". What decides here is how much room this row actually has. */}
                    {open ? (
                      <span
                        ref={setControlsHost}
                        className="order-last mt-1 flex basis-full items-center justify-end gap-1 pb-1 @[560px]:order-none @[560px]:basis-auto @[560px]:pb-0"
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
                      className="min-h-0 flex-1 border-t border-border"
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
                className="flex min-h-9 shrink-0 items-center gap-2 py-1 pr-1.5 pl-3 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground"
              >
                <span className="min-w-0 flex-1 truncate font-mono">{ref.sessionId}</span>
                <SourceBadge source={ref.source} />
                <span>missing</span>
                <SessionRowMenu label={ref.sessionId} onDetach={() => onDetachSession(bot, ref)} />
              </li>
            ))}
          </ul>
        )}

        {/* A row in the card rather than a strip floating over its bottom edge. Overlaid it would
            land on the composer's last few pixels, and the card clips its own overflow, so a handle
            hanging outside the border would not be there to grab. */}
        {holdsOpen ? (
          <div
            role="separator"
            aria-label={`Resize ${bot.name} card`}
            aria-orientation="horizontal"
            aria-valuemin={MIN_CARD_HEIGHT}
            aria-valuemax={tallest()}
            aria-valuenow={height}
            aria-valuetext={`${height} pixels`}
            tabIndex={0}
            className="group flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center border-t border-border outline-none"
            onPointerDown={startDrag}
            onPointerMove={(event) => dragTo(event, { height: true })}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onKeyDown={(event) => resizeFromKeyboard(event, "height")}
          >
            <span className="h-0.5 w-8 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary" />
          </div>
        ) : null}
      </div>

      {/* The card's right edge, which is the width grip and -- once there is a bottom edge to meet
          -- the corner where the two of them join. Absent entirely when the canvas is showing one
          card at a time: there is no width left to drag a card to, and a drag that could only ever
          arrive at the panel's own width would overwrite the width this Bot has on a Mac. */}
      {carouselWidth === null ? (
        <div className="flex w-3 shrink-0 flex-col">
          {/* Every card, open or not: a tile has a width whether or not you are reading it. */}
          <div
            role="separator"
            aria-label={`Widen ${bot.name} card`}
            aria-orientation="vertical"
            aria-valuemin={MIN_CARD_WIDTH}
            aria-valuemax={widest()}
            aria-valuenow={width}
            aria-valuetext={`${width} pixels`}
            tabIndex={0}
            className="group flex min-h-0 flex-1 cursor-col-resize touch-none items-center justify-center border-l border-border outline-none"
            onPointerDown={startDrag}
            onPointerMove={(event) => dragTo(event, { width: true })}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onKeyDown={(event) => resizeFromKeyboard(event, "width")}
          >
            <span className="h-8 w-0.5 rounded-full bg-border transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary" />
          </div>

          {/* Both axes in one drag, sitting where the two edges already meet.

              Hidden from assistive technology and left out of the tab order on purpose, which is not
              the usual answer for a control: it does nothing the two separators either side of it
              cannot already do, including from the keyboard, so exposing it would be a third name for
              the same card offering no third capability. It is a pointer shortcut over two controls
              that are properly labelled, and a pointer is the only thing that can express a diagonal.

              Only when the card has a height to drag. Closed, there is no bottom edge for a corner to
              be the corner of. */}
          {holdsOpen ? (
            <div
              aria-hidden
              // A tooltip because there is no label: the two separators say what they do through
              // their names, and this one has none to say it with.
              title="Resize both ways"
              className="group flex size-3 shrink-0 cursor-nwse-resize touch-none items-center justify-center border-t border-l border-border"
              onPointerDown={startDrag}
              onPointerMove={(event) => dragTo(event, { width: true, height: true })}
              onPointerUp={finishDrag}
              onPointerCancel={finishDrag}
            >
              <span className="size-1.5 rounded-[1px] bg-border transition-colors group-hover:bg-primary/60" />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
