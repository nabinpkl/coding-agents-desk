import { Bot, ChevronDown, LoaderCircle, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionView, type SessionViewContext } from "../session-view/SessionView";
import { ActivityDot, SessionMeta } from "../sidebar/SessionMeta";
import { SourceBadge } from "../sidebar/SourceBadge";
import { BotAvatar } from "./BotSidebarPanel";
import {
  DEFAULT_CARD_SIZE,
  botCanvasOrderOf,
  loadBotCanvasOrder,
  loadSessionCardSizes,
  moveInOrder,
  orderBotsForCanvas,
  storeBotCanvasOrder,
  storeSessionCardSizes,
  type BotCardSize,
  type BotCardSizes,
} from "./botCanvasPreferences";
import { botSurfaceStyle } from "./botSurface";
import { BotCardMenu } from "./BotCardMenu";
import { BotNewSessionCard, type NewBotSession } from "./BotNewSessionCard";
import { SessionRowMenu } from "./SessionRowMenu";
import { useCardResize } from "./useCardResize";

/** The `gap-3` between cards, in pixels, which a card stepping aside has to clear as well. */
const STRIP_GAP = 12;

/**
 * How wide a session stands while it is closed, which is not a number anyone chose and not one
 * that is remembered.
 *
 * A closed session is a spine: a name, when it last said something, and the menu. It has no
 * contents to be a width FOR, so a width dragged onto it would be a width you set for a box you
 * could not see inside -- and it would then be the width you found the next time you opened it,
 * which is not what you meant. Wide enough for a truncated title beside its chevron, and narrow
 * enough that a Bot with several reads as a rank of spines rather than a stack of slabs.
 */
const CLOSED_SESSION_WIDTH = 260;

/**
 * A failed Bot command, and which session it was about.
 *
 * The session is carried because the canvas holds several at once and the failure belongs to one of
 * them: a bare string was shown on every open card, which named none of them and repeated itself
 * once per session the reader had open.
 *
 * Null where the failure is not about one particular session. So is a failure about a session the
 * canvas is not showing, which an attach that did not happen always is -- the session never joined
 * the Bot, so no card exists to carry it. Those go to the canvas's own band, said once rather than
 * lost.
 */
export interface BotCommandError {
  /** `source:sessionId`, or null when no card can carry it. */
  session: string | null;
  message: string;
}

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
 * into. It is not a preview of a session, it is one -- which is why closing it unmounts rather than
 * hides it. As many can be open at once as the reader opens; see `BotCanvasList` for the budget
 * that rule was measured against, and note that anything a card portals out of itself needs a node
 * of its own rather than the app's, or the open sessions land on top of each other.
 */
export function BotCanvas({
  bots,
  hues,
  loading,
  error,
  sessionContext,
  botError,
  onAddSession,
  onForkSession,
  onRenameSession,
  onDetachSession,
  onDetachBot,
  detachedCount,
  openKeys,
  onToggleSession,
  onAddBot,
  newSessions,
  onCloseNewSession,
}: {
  bots: BotView[];
  /**
   * Every Bot's hue, by id, computed over the WHOLE roster rather than over the cards below.
   *
   * It arrives as a prop for that reason alone: this component is given the Bots on the canvas, and
   * ranking those would recolour the strip every time a reader took one off it. See
   * `botSurface.ts`.
   */
  hues: ReadonlyMap<string, number>;
  loading: boolean;
  error: string | null;
  /**
   * Everything an opened row's session needs that is not the session, built once by the shell.
   * The same object the thread view is given, which is what makes a row here the same surface
   * rather than a lesser copy of it.
   */
  sessionContext: SessionViewContext;
  /**
   * A failure from editing a Bot, shown on the card of the session it was about.
   *
   * This surface is where a detach is most likely to be pressed -- the action is in every row's
   * menu -- so the card that failed to go away is what says so. One about no session, or about a
   * session this canvas is not showing, goes to the canvas's own band instead.
   */
  botError: BotCommandError | null;
  onAddSession: (bot: BotView) => void;
  /** Branches a new session from this one, in its own pane, and gives it to the Bot. */
  onForkSession: (bot: BotView, session: SessionSummary) => void;
  /** Opens the rename dialog for this session. Claude only; a Codex row does not offer it. */
  onRenameSession: (session: SessionSummary) => void;
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
   * Which sessions are open, as `source:sessionId`, owned above this component.
   *
   * It used to live in `BotCanvasList`, and it moved out when the sidebar beside the canvas gained
   * the same rows: a session picked over there opens the card over here, which cannot work while
   * the only copy of the answer is inside the thing being driven.
   */
  openKeys: ReadonlySet<string>;
  /** Opens that session, or closes it if it is already open. */
  onToggleSession: (key: string) => void;
  onAddBot: () => void;
  /**
   * Sessions this panel has started that the catalog does not know yet.
   *
   * They cannot arrive through `bots` and that is not an omission: a Bot curates references the
   * sidecar resolved, and the sidecar refuses a reference to a session with no transcript. So a
   * session lives here from the moment it is started until its first turn writes one, at which
   * point the shell attaches it and it becomes an ordinary row on its Bot. See `BotNewSessionCard`.
   */
  newSessions: readonly NewBotSession[];
  /** Takes the card away. The tmux session keeps running; nothing was attached to detach. */
  onCloseNewSession: (sessionId: string) => void;
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
      hues={hues}
      sessionContext={sessionContext}
      botError={botError}
      onAddSession={onAddSession}
      onForkSession={onForkSession}
      onRenameSession={onRenameSession}
      onDetachSession={onDetachSession}
      onDetachBot={onDetachBot}
      openKeys={openKeys}
      onToggleSession={onToggleSession}
      newSessions={newSessions}
      onCloseNewSession={onCloseNewSession}
    />
  );
}

/**
 * The roster, with as many sessions open in it as the reader has opened.
 *
 * It held one at a time until the budget behind that rule was measured. An open row is an event
 * stream, a background-task stream, a summary probe and a CLI-status poll -- and, once its terminal
 * is opened, a pty attach. The ceiling is CHROME's, not the sidecar's: a browser allows 100
 * concurrent streams per HTTP/2 origin and parks the excess in CONNECTING with no error at all,
 * which is about thirty open cards, against a machine that holds six sessions. The sidecar's own
 * per-session cost went with it -- every watched session now shares one process table, one registry
 * pass and one `lsof` per tick, so 18 of them cost what 8 used to.
 *
 * The phone is the surface where one card is still most of the screen, and that stays the reader's
 * call: nothing here caps the count, because the cards are what the reader arranged.
 *
 * Closing a row UNMOUNTS it rather than hiding it, which is what keeps a closed card free: every
 * one of those subscriptions belongs to a hook inside `SessionView`, so they end with it.
 */
function BotCanvasList({
  bots,
  hues,
  sessionContext,
  botError,
  onAddSession,
  onForkSession,
  onRenameSession,
  onDetachSession,
  onDetachBot,
  openKeys,
  onToggleSession,
  newSessions,
  onCloseNewSession,
}: {
  bots: BotView[];
  hues: ReadonlyMap<string, number>;
  sessionContext: SessionViewContext;
  botError: BotCommandError | null;
  onAddSession: (bot: BotView) => void;
  onForkSession: (bot: BotView, session: SessionSummary) => void;
  /** Opens the rename dialog for this session. Claude only; a Codex row does not offer it. */
  onRenameSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  onDetachBot: (bot: BotView) => void;
  openKeys: ReadonlySet<string>;
  onToggleSession: (key: string) => void;
  newSessions: readonly NewBotSession[];
  onCloseNewSession: (sessionId: string) => void;
}) {
  // Every Bot's card size, read once at mount and written on release rather than on every pointer
  // move, so a drag is one storage write.
  const [sessionSizes, setSessionSizes] = useState<BotCardSizes>(loadSessionCardSizes);
  const [order, setOrder] = useState<string[]>(loadBotCanvasOrder);
  const standing = orderBotsForCanvas(bots, order);
  // The scroller and the strip inside it. The scroller is what gets measured -- the list is
  // `w-max`, so it reports its own contents, and widening a card would grow the very thing being
  // asked how much room a card has -- and the strip is what a move reads card positions from.
  const canvas = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  // `moveInOrder` hands back the same array when the move is a no-op, which is what makes the
  // identity check below meaningful rather than a comparison of two fresh arrays.
  const rearrange = (from: number, to: number): void => {
    const current = botCanvasOrderOf(standing);
    const next = moveInOrder(current, from, to);
    if (next === current) return;
    setOrder(next);
    storeBotCanvasOrder(next);
  };
  const move = useMoveAlongStrip({ canvas, list, onDrop: rearrange });
  const resizeSession =(key: string, size: BotCardSize, keep: boolean): void => {
    const next = { ...sessionSizes, [key]: size };
    setSessionSizes(next);
    // Pruned to what is on the canvas as it is written. Sessions are not bounded the way Bots are,
    // so a store that only ever grew would carry a size for every session ever opened.
    if (keep) {
      storeSessionCardSizes(
        next,
        [
          ...bots.flatMap((each) => each.sessions.map((session) => sessionKey(session))),
          // A session that has been started but has not spoken is on the canvas and is not in any
          // Bot yet, so a prune that only read the Bots would throw away the width of the card the
          // reader is dragging.
          ...newSessions.map((each) => `claude:${each.sessionId}`),
        ],
      );
    }
  };
  // A failure no card can carry: one about no session, or about a session that is not on this
  // canvas. An attach that FAILED is exactly that -- the session never joined the Bot, so nothing
  // shows it -- and without this the only report of it would be dropped on the floor.
  const carried = botError !== null && botError.session !== null
    && standing.some((bot) => bot.sessions.some((each) => sessionKey(each) === botError.session));
  const orphanedError = botError !== null && !carried ? botError.message : null;
  return (
    <div ref={canvas} className="h-full overflow-auto overscroll-contain">
      {orphanedError ? (
        <div
          role="alert"
          className="mx-3 mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive"
        >
          {orphanedError}
        </div>
      ) : null}
      {/* One strip, and nothing wraps out of it. A card widened here takes the room and pushes the
          cards after it along; none of them can drop to a line below, because there is no line
          below. That is the whole difference from the grid this replaced, and it is why the canvas
          scrolls sideways rather than being capped to fit.

          `items-start` because a card is as tall as its own roster: without it every card stretches
          to the tallest, so a Bot with two sessions beside a Bot with twelve becomes a card mostly
          made of empty. The cost is a ragged bottom edge, which is the honest shape of a row that
          holds different amounts. */}
      <ul ref={list} role="list" aria-label="Bot canvas" className="flex w-max items-start gap-3 p-3">
        {standing.map((bot, index) => (
          <BotCanvasCard
            key={bot.botId}
            offset={move.offsetOf(index)}
            lifted={move.liftedIndex === index}
            onMoveStart={(clientX) => move.start(index, clientX)}
            onMoveBy={move.to}
            onMoveEnd={move.end}
            onMoveBySteps={(steps) => rearrange(index, index + steps)}
            canMoveLeft={index > 0}
            canMoveRight={index < standing.length - 1}
            bot={bot}
            hue={hues.get(bot.botId)}
            sessionContext={sessionContext}
            botError={botError}
            openKeys={openKeys}
            onToggleSession={onToggleSession}
            sessionSizes={sessionSizes}
            onResizeSession={resizeSession}
            onAddSession={onAddSession}
            onForkSession={onForkSession}
            onRenameSession={onRenameSession}
            onDetachSession={onDetachSession}
            onDetachBot={onDetachBot}
            newSessions={newSessions.filter((each) => each.botId === bot.botId)}
            onCloseNewSession={onCloseNewSession}
          />
        ))}
      </ul>
    </div>
  );
}

/** How close to an edge a drag has to get before the strip scrolls itself, and how fast. */
const EDGE_SCROLL_MARGIN = 56;
const EDGE_SCROLL_STEP = 14;

interface StripMove {
  /** The index being carried, or null when nothing is. */
  liftedIndex: number | null;
  /** How far the card at `index` is displaced from where the strip laid it out. */
  offsetOf: (index: number) => number;
  start: (index: number, clientX: number) => void;
  to: (clientX: number) => void;
  end: () => void;
}

/**
 * Carrying one card along the strip and dropping it somewhere else in the order.
 *
 * Everything moves by TRANSFORM and nothing is re-parented, which is not a rendering preference: a
 * card can hold a live session -- an event stream, a background-task stream, a summary probe, a
 * CLI-status poll, and once its terminal is open, a pty attach. Rendering the card being dragged
 * into a layer of its own would unmount `SessionView` and stand every one of those back up on
 * drop, so the card stays exactly where it is in the tree and is merely drawn somewhere else.
 *
 * Positions are read ONCE, when the drag begins. Reading them again mid-drag would be reading the
 * transforms this is applying, and the card would chase itself.
 */
function useMoveAlongStrip({
  canvas,
  list,
  onDrop,
}: {
  canvas: React.RefObject<HTMLDivElement | null>;
  list: React.RefObject<HTMLUListElement | null>;
  onDrop: (from: number, to: number) => void;
}): StripMove {
  const laidOut = useRef<{ left: number; width: number }[]>([]);
  const from = useRef(0);
  const pointer = useRef(0);
  const scrolling = useRef<number | null>(null);
  const [carried, setCarried] = useState<{ from: number; to: number; dx: number } | null>(null);

  const stopScrolling = (): void => {
    if (scrolling.current !== null) cancelAnimationFrame(scrolling.current);
    scrolling.current = null;
  };

  const measure = (clientX: number): void => {
    const cards = laidOut.current;
    const held = cards[from.current];
    if (!held) return;
    // Against the strip rather than the window, so scrolling under the drag does not read as the
    // pointer having moved.
    const dx = clientX - pointer.current;
    const centre = held.left + dx + held.width / 2;
    let to = from.current;
    for (let i = 0; i < cards.length; i += 1) {
      if (i === from.current) continue;
      const other = cards[i]!;
      const otherCentre = other.left + other.width / 2;
      if (i > from.current && centre > otherCentre) to = Math.max(to, i);
      if (i < from.current && centre < otherCentre) to = Math.min(to, i);
    }
    setCarried({ from: from.current, to, dx });
  };

  const start = (index: number, clientX: number): void => {
    const strip = list.current;
    if (!strip) return;
    const origin = strip.getBoundingClientRect().left;
    laidOut.current = [...strip.children].map((child) => {
      const box = child.getBoundingClientRect();
      return { left: box.left - origin, width: box.width };
    });
    from.current = index;
    pointer.current = clientX;
    setCarried({ from: index, to: index, dx: 0 });
  };

  const to = (clientX: number): void => {
    measure(clientX);
    const scroller = canvas.current;
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const step =
      clientX > box.right - EDGE_SCROLL_MARGIN
        ? EDGE_SCROLL_STEP
        : clientX < box.left + EDGE_SCROLL_MARGIN
          ? -EDGE_SCROLL_STEP
          : 0;
    if (step === 0) {
      stopScrolling();
      return;
    }
    if (scrolling.current !== null) return;
    // A loop rather than a scroll per pointer event, because holding a card still against the edge
    // is exactly how you reach a card that is off screen, and a still pointer sends no events.
    const creep = (): void => {
      const node = canvas.current;
      if (!node) return;
      node.scrollLeft += step;
      measure(clientX);
      scrolling.current = requestAnimationFrame(creep);
    };
    scrolling.current = requestAnimationFrame(creep);
  };

  const end = (): void => {
    stopScrolling();
    const held = carried;
    setCarried(null);
    if (held && held.to !== held.from) onDrop(held.from, held.to);
  };

  useEffect(() => stopScrolling, []);

  return {
    liftedIndex: carried?.from ?? null,
    offsetOf: (index) => {
      if (!carried) return 0;
      if (index === carried.from) return carried.dx;
      const held = laidOut.current[carried.from];
      if (!held) return 0;
      // A card the held one has passed steps aside by exactly the room the held one takes.
      const stride = held.width + STRIP_GAP;
      if (carried.to > carried.from && index > carried.from && index <= carried.to) return -stride;
      if (carried.to < carried.from && index < carried.from && index >= carried.to) return stride;
      return 0;
    },
    start,
    to,
    end,
  };
}

/**
 * One of a Bot's sessions, which is a Bot one level down.
 *
 * A ROW until it is opened, filling the card it sits in, because a roster of twelve sessions you
 * are not reading is a list rather than twelve boxes. Opened, it becomes a card in its own right:
 * its own width, its own height, its own three grips, remembered against its own session. Nothing
 * about it is derived from the Bot card around it -- that card grows to fit this one, rather than
 * this one being fitted into what the card had left over.
 *
 * The space beside a session narrower than its Bot card is deliberate. Nothing sits there today,
 * and it is where a second open session goes when more than one at a time is allowed.
 */
function BotSessionCard({
  bot,
  session,
  open,
  onToggle,
  size,
  onResize,
  onResizeCommit,
  sessionContext,
  botError,
  onFork,
  onRename,
  onDetach,
}: {
  bot: BotView;
  session: SessionSummary;
  open: boolean;
  onToggle: () => void;
  size: BotCardSize;
  onResize: (size: BotCardSize) => void;
  onResizeCommit: (size: BotCardSize) => void;
  sessionContext: SessionViewContext;
  botError: BotCommandError | null;
  /** Absent on a Codex session: only the Claude CLI has a fork to ask for. */
  onFork?: () => void;
  /** Absent on a Codex session, whose title this panel does not own. */
  onRename?: () => void;
  onDetach: () => void;
}) {
  const title = session.title || session.sessionId;
  // Where this session portals its control strip. One per session rather than one per Bot card,
  // which is what lets two of them be open at once without their controls landing in the same
  // place. State rather than a ref, because the session has to render again once the node exists.
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null);
  /**
   * Where this session's background-tasks panel lands, for the same reason `controlsHost` exists.
   *
   * The app offers ONE host for it, which is right for the thread view where one session is the
   * page and wrong here: the panel is `absolute inset-y-0 right-0`, so two open sessions portalling
   * into that one node put two panels at the same coordinates, stacked, with nothing saying which
   * session either belongs to. Given its own node inside the card, each lands over its own session.
   */
  const [tasksHost, setTasksHost] = useState<HTMLElement | null>(null);
  const resize = useCardResize({
    name: title,
    noun: "session",
    size,
    canResizeWidth: open,
    canResizeHeight: open,
    onResize,
    onResizeCommit,
  });
  return (
    // Opened, the width it was last given; closed, the spine's own. Always one of the two, at every
    // panel width: this row is `shrink-0` inside a flex row, so it does not stretch to a container
    // on the main axis, and the column inside it is `flex-1 min-w-0`. Leaving the width off
    // therefore resolved the whole session to ZERO -- which is what a phone showed, a Bot card with
    // an empty body and a one-pixel sliver where the roster should be.
    <li className="shrink-0" style={{ width: open ? resize.width : CLOSED_SESSION_WIDTH }}>
      <div
        // `relative` so this card is what the session's tasks panel is positioned against. That
        // panel is absolutely placed against its nearest positioned ancestor, which without this
        // is the app itself -- and then every open session's panel lands in the same place.
        className={`relative flex overflow-hidden rounded-lg border ${
          open ? "border-primary" : "border-border"
        }`}
        style={open ? { height: resize.height } : undefined}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          {/* A button cannot contain a button, so opening the session, its controls and its menu
              are siblings and the open tint moves up to the box that holds them -- the same shape
              the sidebar's rows took when they grew this menu. Open, this row is the session's
              titlebar: it is where its controls land, the way the app header is where the thread
              view's land. */}
          <div
            className={`@container flex shrink-0 flex-wrap items-start pr-1.5 ${
              open ? "bg-muted" : ""
            }`}
          >
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-2 py-2 pr-2 pl-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
            >
              <ActivityDot activity={session.activity} className="mt-1.5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
                  {title}
                </span>
                <SessionMeta
                  source={session.source}
                  lastEventAt={session.lastEventAt}
                  activity={session.activity}
                />
              </span>
              <ChevronDown
                className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            {/* Its own line in a narrow row, inline once there is room. A session's controls are
                five icons wide, which in a narrow card leaves the title about one character: the
                name of the thing is worth more than keeping this to one line. `order-last` rather
                than DOM order, so the menu stays beside the title where it is on every closed row
                and does not move when one opens.

                The query is on this ROW, not the viewport. A `sm:` breakpoint asks how wide the
                window is, and a card on a wide Mac is narrower than a phone: it kept the controls
                inline in a 451px card and truncated the title to "CPU and RA...". What decides here
                is how much room this row actually has. */}
            {open ? (
              <span
                ref={setControlsHost}
                className="order-last mt-1 flex basis-full items-center justify-end gap-1 pb-1 @[560px]:order-none @[560px]:basis-auto @[560px]:pb-0"
              />
            ) : null}
            <span className="mt-1">
              <SessionRowMenu
                label={title}
                onRename={onRename}
                onFork={onFork}
                onDetach={onDetach}
              />
            </span>
          </div>
          {/* On the card rather than handed to the session as an `externalError`.
              A Bot failure is about the session's place on this canvas, not about its composer,
              and the composer band would not show it anyway: every Claude and Codex session is on
              the window, inbox or tmux band, each of which captions itself and outranks it. So
              routing it there addressed the right session and then said nothing to anybody. It is
              also shown whether or not the card is open, because closing a session is a plausible
              thing to do right after failing to remove it. */}
          {botError && botError.session === sessionKey(session) ? (
            <p
              role="alert"
              className="border-t border-destructive/40 bg-destructive/10 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive"
            >
              {botError.message}
            </p>
          ) : null}
          {open ? (
            // A named landmark rather than a bare box: a canvas of open sessions is a page with
            // several of them on it, and each one should be reachable by name.
            <section className="min-h-0 flex-1 border-t border-border" aria-label={`${title} session`}>
              {/* The same component the app's own thread view renders, given a box instead of the
                  page. It needs nothing said to it about being small: everything in it measures the
                  column it is, so the box decides. */}
              <SessionView
                {...sessionContext}
                projectPath={bot.environment.path}
                session={session}
                controlsHost={controlsHost}
                tasksHost={tasksHost}
              />
            </section>
          ) : null}
          {resize.bottom}
        </div>
        {/* `contents` so this box is not one: the panel inside it positions against the card. */}
        <div ref={setTasksHost} className="contents" />
        {resize.edge}
      </div>
    </li>
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
  hue,
  sessionContext,
  botError,
  openKeys,
  onToggleSession,
  sessionSizes,
  onResizeSession,
  offset,
  lifted,
  onMoveStart,
  onMoveBy,
  onMoveEnd,
  onMoveBySteps,
  canMoveLeft,
  canMoveRight,
  onAddSession,
  onForkSession,
  onRenameSession,
  onDetachSession,
  onDetachBot,
  newSessions,
  onCloseNewSession,
}: {
  bot: BotView;
  /** This Bot's place on the colour wheel, or nothing if the roster does not know it yet. */
  hue: number | undefined;
  sessionContext: SessionViewContext;
  botError: BotCommandError | null;
  openKeys: ReadonlySet<string>;
  onToggleSession: (key: string) => void;
  /** Every session's own size, by `source:sessionId`. */
  sessionSizes: BotCardSizes;
  onResizeSession: (key: string, size: BotCardSize, keep: boolean) => void;
  /** How far this card is drawn from where the strip laid it out, while a move is happening. */
  offset: number;
  /** Whether this is the card being carried, rather than one stepping aside for it. */
  lifted: boolean;
  onMoveStart: (clientX: number) => void;
  onMoveBy: (clientX: number) => void;
  onMoveEnd: () => void;
  /** The keyboard's way to the same thing: one place left or right in the order. */
  onMoveBySteps: (steps: number) => void;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onAddSession: (bot: BotView) => void;
  onForkSession: (bot: BotView, session: SessionSummary) => void;
  /** Opens the rename dialog for this session. Claude only; a Codex row does not offer it. */
  onRenameSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  onDetachBot: (bot: BotView) => void;
  /** This Bot's share of the sessions the panel has started, already filtered to it. */
  newSessions: readonly NewBotSession[];
  onCloseNewSession: (sessionId: string) => void;
}) {
  const projectName = bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path;
  // Dropped as soon as the Bot itself carries the session, rather than when the shell decides it
  // should be gone. The two happen a snapshot apart, and rendering both for that moment would put
  // two cards with one identity side by side.
  const starting = newSessions.filter(
    (each) => !bot.sessions.some((session) => session.sessionId === each.sessionId),
  );
  // A press on the header is a click until it has travelled far enough to be a carry. Without that
  // threshold the header's own buttons would fire a move on every tap, and a hand that shifts two
  // pixels while clicking "Add sessions" would reorder the canvas.
  const grab = useRef<{ pointerId: number; startX: number; carrying: boolean } | null>(null);
  const MOVE_THRESHOLD = 4;
  const grabHeader = (event: React.PointerEvent<HTMLDivElement>): void => {
    // Never from a control. The header holds the add button and the Bot's menu, and a drag that
    // began on either would swallow the press that was meant for it.
    if ((event.target as HTMLElement).closest("button")) return;
    grab.current = { pointerId: event.pointerId, startX: event.clientX, carrying: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const carryHeader = (event: React.PointerEvent<HTMLDivElement>): void => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    if (!held.carrying) {
      if (Math.abs(event.clientX - held.startX) < MOVE_THRESHOLD) return;
      held.carrying = true;
      onMoveStart(held.startX);
    }
    onMoveBy(event.clientX);
  };
  const dropHeader = (event: React.PointerEvent<HTMLDivElement>): void => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    grab.current = null;
    if (held.carrying) onMoveEnd();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  const live = bot.sessions.filter((session) => session.activity === "live").length;
  const counted = `${bot.sessions.length} ${bot.sessions.length === 1 ? "session" : "sessions"}${
    live > 0 ? `, ${live} live` : ""
  }`;
  // Whether an open session is one of THIS card's, which is what the scroll below acts on.
  const holdsOpen = bot.sessions.some((session) => openKeys.has(sessionKey(session)));
  // Brings this card into view when it becomes an open one, because the row that opened it may
  // have been in the sidebar rather than on the canvas, and the card can be anywhere in a tiled
  // roster of thirty. `nearest` rather than `start`: it does nothing at all when the card is
  // already fully visible, which is the common case of clicking a row on the canvas itself, and a
  // card taller than the scroller aligns to its top under the same rule.
  const card = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (!holdsOpen) return;
    card.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [holdsOpen]);
  // `bot-surface` sets the background and the border together, because a tinted card inside a
  // neutral border reads as a mistake rather than as a colour. A Bot the roster has not ranked
  // falls back to the plain card it was, which is defensive rather than expected: the canvas shows
  // a subset of the roster the hues are built from.
  const surface = hue === undefined ? "bg-card" : "bot-surface";
  // A card being carried says something about right now, which outranks saying whose it is.
  const edge = lifted ? "z-10 border-primary shadow-xl" : surface === "bg-card" ? "border-border" : "";
  return (
    // Width always, height only while it holds the open session: closed, a card is as tall as its
    // own roster and a remembered height would be empty space. The card is a ROW -- its content
    // beside the strip that widens it -- because the card clips its own overflow, so a handle
    // hanging off the border would not be there to grab, and one overlaid on the inside edge would
    // land on the transcript's scrollbar.
    <li
      ref={card}
      className={`flex shrink-0 overflow-hidden rounded-xl border ${surface} ${edge}`}
      style={{
        ...botSurfaceStyle(hue),
        // No size of its own, at any panel width. A Bot card is exactly as big as the sessions
        // standing in it, in both directions: it once held a width and a height, and both turned
        // into empty space the moment the sessions carried their own. A narrow panel is not an
        // exception -- the strip scrolls, so a phone crawls sideways across a card the same way a
        // Mac does, rather than having one pinned to its width.
        transform: offset === 0 ? undefined : `translateX(${offset}px)`,
        // The carried card tracks the pointer exactly; the ones stepping aside for it are the only
        // thing that should look like it is moving.
        transition: lifted ? undefined : "transform 150ms ease",
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Not sticky, and it never was in effect. It carried `sticky top-0` from the days of a
            single scrolling column, but the card clips its own overflow, which makes the CARD the
            scrollport this would stick inside -- and a card never scrolls. Measured: with the
            card's top 288px above the scroller's top, the header sat at the card's top, not the
            scroller's. */}
        {/* `w-0 min-w-full` is what stops the header deciding how wide the card is. A card is
            sized by its contents, and contents are measured at MAX-content -- so the Bot's full
            name and full project path were setting a width the sessions never asked for, and
            `truncate` never engaged because nothing was ever constraining it. A percentage
            min-width cannot be resolved while that measurement is happening, so the header counts
            as zero then and stretches to the answer afterwards. */}
        <div
          // No background of its own. It had `bg-card` from when the card was `bg-card`, which was
          // the same colour and so invisible; now that the card carries a hue, repainting the band
          // that holds the Bot's name would be the one part of the card not wearing it.
          className="flex w-0 min-w-full shrink-0 cursor-grab items-center gap-3 border-b border-border px-3 py-2 select-none active:cursor-grabbing"
          onPointerDown={grabHeader}
          onPointerMove={carryHeader}
          onPointerUp={dropHeader}
          onPointerCancel={dropHeader}
        >
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
          {/* A count, not a sentence. "3 sessions" said in a header sitting over three sessions is
              a word spent naming what is directly underneath it; the number is the only part that
              was carrying anything. The dot is there only when something is live, which is the one
              thing the spines below cannot tell you at a glance once there are several. */}
          <span
            className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium text-muted-foreground"
            title={counted}
          >
            {live > 0 ? <ActivityDot activity="live" /> : null}
            <span aria-hidden>{bot.sessions.length}</span>
            <span className="sr-only">{counted}</span>
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
          <BotCardMenu
            bot={bot}
            onDetach={() => onDetachBot(bot)}
            onMoveLeft={canMoveLeft ? () => onMoveBySteps(-1) : undefined}
            onMoveRight={canMoveRight ? () => onMoveBySteps(1) : undefined}
          />
        </div>

        {bot.sessions.length === 0 && bot.missingSessionRefs.length === 0 && starting.length === 0 ? (
          <p className="px-3 py-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            No sessions attached
          </p>
        ) : (
          // The one flexible thing in the card: closed rows keep their own height, so a drag lands
          // entirely on the open session. Squeezed hard enough the session collapses to nothing and
          // the roster stays readable, which is the recoverable way round -- drag it taller again.
          // A Bot's sessions stand SIDE BY SIDE, which is the same shape the canvas has one level
          // up: a strip of boxes each at its own width, and nothing wrapping out of it. A column
          // per session is what makes opening one a local act -- it grows downwards in its own
          // place while the rest keep theirs, instead of taking over the width of a list.
          <ul
            role="list"
            aria-label={`${bot.name} sessions`}
            className="flex items-start gap-2 p-2"
          >
            {bot.sessions.map((session) => (
              <BotSessionCard
                key={sessionKey(session)}
                bot={bot}
                session={session}
                open={openKeys.has(sessionKey(session))}
                onToggle={() => onToggleSession(sessionKey(session))}
                size={sessionSizes[sessionKey(session)] ?? DEFAULT_CARD_SIZE}
                onResize={(next) => onResizeSession(sessionKey(session), next, false)}
                onResizeCommit={(next) => onResizeSession(sessionKey(session), next, true)}
                sessionContext={sessionContext}
                botError={botError}
                // Both Claude-only, and absent rather than inert on a Codex row: forking asks the
                // Claude CLI for a branch it alone has, and the title being renamed is a record in
                // a transcript this panel does not write for Codex.
                onFork={
                  session.source === "claude" ? () => onForkSession(bot, session) : undefined
                }
                onRename={
                  session.source === "claude" ? () => onRenameSession(session) : undefined
                }
                onDetach={() => onDetachSession(bot, session)}
              />
            ))}
            {/* After the Bot's own sessions, because that is where each one lands the moment its
                first turn writes a transcript: the card keeps its place in the row rather than
                jumping to the end of it. */}
            {starting.map((each) => (
              <BotNewSessionCard
                key={`claude:${each.sessionId}`}
                feed={sessionContext.feed}
                session={each}
                open={openKeys.has(`claude:${each.sessionId}`)}
                onToggle={() => onToggleSession(`claude:${each.sessionId}`)}
                size={sessionSizes[`claude:${each.sessionId}`] ?? DEFAULT_CARD_SIZE}
                onResize={(next) => onResizeSession(`claude:${each.sessionId}`, next, false)}
                onResizeCommit={(next) => onResizeSession(`claude:${each.sessionId}`, next, true)}
                onClose={() => onCloseNewSession(each.sessionId)}
              />
            ))}
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

      </div>

    </li>
  );
}
