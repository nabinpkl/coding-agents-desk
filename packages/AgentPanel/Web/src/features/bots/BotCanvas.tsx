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
  botCanvasOrderOf,
  loadBotCanvasOrder,
  moveInOrder,
  orderBotsForCanvas,
  storeBotCanvasOrder,
  loadBotCardSizes,
  storeBotCardSizes,
  type BotCardSize,
  type BotCardSizes,
} from "./botCanvasPreferences";
import { BotCardMenu } from "./BotCardMenu";
import { SessionRowMenu } from "./SessionRowMenu";
import { useCardResize } from "./useCardResize";

/** The `gap-3` between cards, in pixels, which a card stepping aside has to clear as well. */
const STRIP_GAP = 12;

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
  // How wide the canvas is. It no longer bounds a card -- the strip scrolls, so a card may be wider
  // than the panel -- and is measured for one question only: whether there is room to put two cards
  // side by side at all. Measured rather than queried, because the sidebar is pinnable and
  // resizable, so the window's width is not this panel's.
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
  offset,
  lifted,
  onMoveStart,
  onMoveBy,
  onMoveEnd,
  onMoveBySteps,
  canMoveLeft,
  canMoveRight,
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
  const resize = useCardResize({
    name: bot.name,
    noun: "card",
    size,
    displayWidth: carouselWidth,
    canResizeHeight: holdsOpen,
    onResize,
    onResizeCommit,
  });
  const { width, height } = resize;
  return (
    // Width always, height only while it holds the open session: closed, a card is as tall as its
    // own roster and a remembered height would be empty space. The card is a ROW -- its content
    // beside the strip that widens it -- because the card clips its own overflow, so a handle
    // hanging off the border would not be there to grab, and one overlaid on the inside edge would
    // land on the transcript's scrollbar.
    <li
      ref={card}
      className={`flex shrink-0 overflow-hidden rounded-xl border bg-card ${
        lifted ? "z-10 border-primary shadow-xl" : "border-border"
      }`}
      style={{
        width,
        transform: offset === 0 ? undefined : `translateX(${offset}px)`,
        // The carried card tracks the pointer exactly; the ones stepping aside for it are the only
        // thing that should look like it is moving.
        transition: lifted ? undefined : "transform 150ms ease",
      }}
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
        <div
          className="flex shrink-0 cursor-grab items-center gap-3 border-b border-border bg-card px-3 py-2 select-none active:cursor-grabbing"
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
          <BotCardMenu
            bot={bot}
            onDetach={() => onDetachBot(bot)}
            onMoveLeft={canMoveLeft ? () => onMoveBySteps(-1) : undefined}
            onMoveRight={canMoveRight ? () => onMoveBySteps(1) : undefined}
          />
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

        {resize.bottom}
      </div>

      {resize.edge}
    </li>
  );
}
