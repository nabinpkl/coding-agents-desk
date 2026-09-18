import { useRef, useState } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import {
  loadSessionCardSizes,
  storeSessionCardSizes,
  type BotCardSize,
  type BotCardSizes,
} from "@/features/bots/botCanvasPreferences";
import { botsOnShownMachines } from "@/features/bots/botMachines";
import { BotNewSessionCard, type NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import { BotCanvasCard } from "@/features/bots/cards/BotCanvasCard";
import { CanvasNotices, CanvasPlaceholder } from "@/features/bots/cards/canvasNotices";
import { sessionKey, type BotCommandError } from "@/features/bots/cards/botCanvasCards";
import { useRememberedCanvasScroll } from "@/features/bots/useRememberedCanvasScroll";
import { useMoveAlongStrip } from "@/features/bots/useMoveAlongStrip";
import { useCanvasZoom } from "@/features/bots/useCanvasZoom";

// Re-exported because this is the canvas's entry point: the app imports the surface and the shape
// of a failure from one name, and the parts moving out did not move that.
export type { BotCommandError };

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
  sessionContextFor,
  machines,
  keyOfBot,
  hiddenMachines,
  machineErrors,
  botError,
  onAddSession,
  onForkSession,
  onForkFromLastMessage,
  onForkFromLastCompaction,
  onRenameSession,
  onDetachSession,
  onRemoveSessionFromCanvas,
  onDetachBot,
  onMoveBot,
  onReorderSessions,
  detachedCount,
  detachedSessionKeys,
  openKeys,
  onToggleSession,
  onAddBot,
  newSessions,
  onCloseNewSession,
  canvasZoom,
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
  /**
   * The context ONE card renders its session in, by Bot.
   *
   * A resolver rather than a context, because the canvas is the surface that shows several machines
   * at once: a Bot whose directory is on a peer must read its transcripts, run its commands and
   * open its terminals through that peer's sidecar. See `botMachines.ts`. A single-machine panel
   * gets the same object back for every Bot, so nothing here notices.
   */
  sessionContextFor: (botId: string) => SessionViewContext;
  /**
   * Every machine whose Bots this canvas reads, and EMPTY when there is only one.
   *
   * The canvas is the one surface that does not obey the tab bar's machine picker -- a Bot is a
   * directory and those are not all on one machine, so showing them side by side is the point --
   * which means it owes the reader a statement of what it IS showing. These are the machines that
   * statement names; the sidebar's canvas roster draws it, and the strip reads the answer. See
   * `BotCanvasStatus`. Used here to label a card with the machine its Bot is on.
   */
  machines: readonly { key: string; label: string }[];
  /** Which machine a Bot is on. Undefined for a Bot no roster claims, which renders unlabelled. */
  keyOfBot: (botId: string) => string | undefined;
  /**
   * Machines the reader is not showing right now, decided in the sidebar's canvas roster.
   *
   * Their cards are absent and their chip is not, which is why this arrives as a set rather than
   * as a shorter `bots`: the count beside a hidden machine's chip is what says how many cards it
   * is holding back, and the strip has to agree with it.
   */
  hiddenMachines: ReadonlySet<string>;
  /**
   * Machines that cannot be read, while others can.
   *
   * Said rather than swallowed, and said HERE rather than in `error`: a declared peer that is
   * unreachable looks exactly like a peer with no Bots on it, so an empty strip where a machine's
   * cards used to be is the one failure on this surface that reports itself as success. The canvas
   * that IS working must not be replaced to say it, which is what `error` does.
   */
  machineErrors: readonly { label: string; reason: string }[];
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
  /** The same fork, starting just before the last thing a person said in that session. */
  onForkFromLastMessage: (session: SessionSummary, projectPath: string) => void;
  onForkFromLastCompaction: (session: SessionSummary, projectPath: string) => void;
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
   * Takes one session's card off this canvas, leaving the Bot's reference to it alone.
   *
   * Takes no Bot, unlike the removal above it, because the answer is not a fact about a Bot: the
   * canvas hides a session, and a session belongs to one Bot at a time, so its key is the whole
   * address.
   */
  onRemoveSessionFromCanvas: (session: BotSessionRef) => void;
  /**
   * Takes the whole Bot off this canvas. The Bot, its curated sessions and their transcripts are
   * untouched -- this arranges the view, and the sidebar's canvas panel is where it waits to come
   * back.
   */
  onDetachBot: (bot: BotView) => void;
  /**
   * Stands one Bot's sessions in a new order, naming the one carried. A Bot command rather than an
   * arrangement of this canvas: that order is the Bot's own and reaches every surface reading it.
   */
  onReorderSessions: (bot: BotView, sessionRefs: BotSessionRef[], moved: BotSessionRef) => void;
  /** Stands one Bot where another stands. By id; see `moveBot` in `useCanvasRoster`. */
  onMoveBot: (moved: string, target: string) => void;
  /**
   * How many Bots exist but are off the canvas, which is only ever asked when `bots` is empty. An
   * empty canvas that says "No bots yet" over a roster of eight is a lie, and would send the reader
   * to Add Bot rather than to the roster their Bots are already in.
   */
  detachedCount: number;
  /**
   * The sessions NOT on the canvas, as `source:sessionId`, whichever Bot holds them.
   *
   * Subtracted from each card's roster rather than from `bots`, because a Bot with every session
   * hidden is still a Bot on the canvas: its header is where sessions are added, and dropping the
   * card would take away the way back to a Bot the reader only meant to tidy.
   */
  detachedSessionKeys: ReadonlySet<string>;
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
  /**
   * Draw the whole canvas at once, small enough to see the arrangement, and pinch to move around it.
   *
   * A mode rather than a replacement, and off it costs nothing: no transform and no wrapper exist
   * in the tree, so the strip keeps the pointer arithmetic and the `position: fixed` semantics it
   * has today. Driven from the sidebar's Canvas roster, which is where the canvas's other chrome
   * lives, because a strip of cards as tall as their own rosters has no row to spare. See
   * `useCanvasZoom`.
   */
  canvasZoom: { mode: boolean; room: number };
}) {
  // Nothing to lay out, so nothing below this point would be about anything: no scroller, no
  // strip, and no offset to come back to. The condition stays here rather than inside the
  // placeholder so a reader of the canvas can see when it does not draw one.
  if (loading || error !== null || bots.length === 0) {
    return (
      <CanvasPlaceholder
        loading={loading}
        error={error}
        detachedCount={detachedCount}
        onAddBot={onAddBot}
      />
    );
  }

  return (
    <BotCanvasList
      bots={bots}
      hues={hues}
      sessionContextFor={sessionContextFor}
      machines={machines}
      keyOfBot={keyOfBot}
      hiddenMachines={hiddenMachines}
      machineErrors={machineErrors}
      botError={botError}
      onAddSession={onAddSession}
      onForkSession={onForkSession}
      onForkFromLastMessage={onForkFromLastMessage}
      onForkFromLastCompaction={onForkFromLastCompaction}
      onRenameSession={onRenameSession}
      onDetachSession={onDetachSession}
      onRemoveSessionFromCanvas={onRemoveSessionFromCanvas}
      onDetachBot={onDetachBot}
      onReorderSessions={onReorderSessions}
      onMoveBot={onMoveBot}
      detachedSessionKeys={detachedSessionKeys}
      openKeys={openKeys}
      onToggleSession={onToggleSession}
      newSessions={newSessions}
      onCloseNewSession={onCloseNewSession}
      canvasZoom={canvasZoom}
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
  sessionContextFor,
  machines,
  keyOfBot,
  hiddenMachines,
  machineErrors,
  botError,
  onAddSession,
  onForkSession,
  onForkFromLastMessage,
  onForkFromLastCompaction,
  onRenameSession,
  onDetachSession,
  onRemoveSessionFromCanvas,
  onDetachBot,
  onMoveBot,
  onReorderSessions,
  detachedSessionKeys,
  openKeys,
  onToggleSession,
  newSessions,
  onCloseNewSession,
  canvasZoom,
}: {
  bots: BotView[];
  hues: ReadonlyMap<string, number>;
  /** See the canvas above: one context per Bot, because a Bot can be on another machine. */
  sessionContextFor: (botId: string) => SessionViewContext;
  /** See the canvas above: the chip row, and which machine each card is on. */
  machines: readonly { key: string; label: string }[];
  keyOfBot: (botId: string) => string | undefined;
  hiddenMachines: ReadonlySet<string>;
  machineErrors: readonly { label: string; reason: string }[];
  botError: BotCommandError | null;
  onAddSession: (bot: BotView) => void;
  onForkSession: (bot: BotView, session: SessionSummary) => void;
  /** The same fork, starting just before the last thing a person said in that session. */
  onForkFromLastMessage: (session: SessionSummary, projectPath: string) => void;
  onForkFromLastCompaction: (session: SessionSummary, projectPath: string) => void;
  /** Opens the rename dialog for this session. Claude only; a Codex row does not offer it. */
  onRenameSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  onRemoveSessionFromCanvas: (session: BotSessionRef) => void;
  onDetachBot: (bot: BotView) => void;
  onReorderSessions: (bot: BotView, sessionRefs: BotSessionRef[], moved: BotSessionRef) => void;
  onMoveBot: (moved: string, target: string) => void;
  detachedSessionKeys: ReadonlySet<string>;
  openKeys: ReadonlySet<string>;
  onToggleSession: (key: string) => void;
  newSessions: readonly NewBotSession[];
  onCloseNewSession: (sessionId: string) => void;
  /** See the canvas above: the whole strip drawn small enough to see at once. */
  canvasZoom: { mode: boolean; room: number };
}) {
  // Every Bot's card size, read once at mount and written on release rather than on every pointer
  // move, so a drag is one storage write.
  const [sessionSizes, setSessionSizes] = useState<BotCardSizes>(loadSessionCardSizes);
  // Hidden machines drop out HERE rather than upstream, because hiding one is a question about what
  // this strip shows and not about which Bots exist: the sidebar roster still lists every one, and
  // its chip still says how many each machine is holding back. Shared with the sidebar's status
  // rather than written twice, because that status counts exactly these.
  const standing = botsOnShownMachines(bots, hiddenMachines, keyOfBot);
  const labelOf = (botId: string): string | undefined => {
    const key = keyOfBot(botId);
    return key === undefined ? undefined : machines.find((machine) => machine.key === key)?.label;
  };
  // The scroller and the strip inside it. The scroller is what gets measured -- the list is
  // `w-max`, so it reports its own contents, and widening a card would grow the very thing being
  // asked how much room a card has -- and the strip is what a move reads card positions from.
  const canvas = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLUListElement | null>(null);
  // Moved by id rather than by these indices: the strip is showing a subset of the roster -- a
  // detached Bot has no card, and a hidden machine's are filtered out -- while the order a drop
  // rewrites is the whole roster's, and the sidebar's list draws from that same one.
  const rearrange = (from: number, to: number): void => {
    const moved = standing[from]?.botId;
    const target = standing[to]?.botId;
    if (moved === undefined || target === undefined) return;
    onMoveBot(moved, target);
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
  // A session taken off the canvas has no card either, so its failure goes to the band as well --
  // otherwise removing a hidden session from its Bot and failing would report to nobody.
  const carried = botError !== null && botError.session !== null
    && !detachedSessionKeys.has(botError.session)
    && standing.some((bot) => bot.sessions.some((each) => sessionKey(each) === botError.session));
  const orphanedError = botError !== null && !carried ? botError.message : null;
  const zoom = useCanvasZoom({
    scroller: canvas, strip: list, on: canvasZoom.mode, room: canvasZoom.room,
  });
  // The stored offset is in content space, so it cannot be put back until the scale is known.
  const rememberScroll = useRememberedCanvasScroll(canvas, standing, {
    scale: zoom.scale,
    ready: !zoom.on || zoom.measured,
    pad: zoom.pad,
  });
  // One strip, and nothing wraps out of it. A card widened here takes the room and pushes the cards
  // after it along; none of them can drop to a line below, because there is no line below. That is
  // the whole difference from the grid this replaced, and it is why the canvas scrolls sideways
  // rather than being capped to fit.
  //
  // `items-start` because a card is as tall as its own roster: without it every card stretches to
  // the tallest, so a Bot with two sessions beside a Bot with twelve becomes a card mostly made of
  // empty. The cost is a ragged bottom edge, which is the honest shape of a row that holds
  // different amounts.
  //
  // Held in a const rather than written inline because the sizer below wraps it only while the
  // zoom mode is drawing small, and JSX has no way to conditionally wrap an element in place.
  const strip = (
    <ul
      ref={list}
      role="list"
      aria-label="Bot canvas"
      style={zoom.stripStyle}
      className="flex w-max items-start gap-3 p-3"
    >
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
          sessionContext={sessionContextFor(bot.botId)}
          {...(labelOf(bot.botId) ? { machineLabel: labelOf(bot.botId)! } : {})}
          botError={botError}
          detachedSessionKeys={detachedSessionKeys}
          openKeys={openKeys}
          onToggleSession={onToggleSession}
          sessionSizes={sessionSizes}
          onResizeSession={resizeSession}
          onAddSession={onAddSession}
          onForkSession={onForkSession}
          onForkFromLastMessage={onForkFromLastMessage}
          onForkFromLastCompaction={onForkFromLastCompaction}
          onRenameSession={onRenameSession}
          onDetachSession={onDetachSession}
          onRemoveSessionFromCanvas={onRemoveSessionFromCanvas}
          onDetachBot={onDetachBot}
          onReorderSessions={onReorderSessions}
          scroller={canvas}
          newSessions={newSessions.filter((each) => each.botId === bot.botId)}
          onCloseNewSession={onCloseNewSession}
        />
      ))}
    </ul>
  );
  return (
    <div
      ref={canvas}
      onScroll={rememberScroll}
      style={zoom.scrollerStyle}
      // The margin is the SCROLLER's rather than padding on the strip inside it, so the gutter
      // holds while the canvas is scrolled: cards enter and leave at the inset edge instead of
      // running to the window's, and the strip reads as a region with room around it rather than
      // as content pressed against the panel. It is horizontal only -- the vertical run is what
      // the cards are measured in, and the bar this surface no longer draws already gave it back.
      className="mx-4 h-full overflow-auto overscroll-contain"
    >
      <CanvasNotices
        machineErrors={machineErrors}
        onCanvas={bots.length}
        drawn={standing.length}
        orphanedError={orphanedError}
      />
      {/* The SIZER. A transform does not change `scrollWidth`, so without a box sized to what is
          actually drawn the scroller keeps a range several times wider than its contents and most
          of it is empty. With one, panning is ordinary scrolling, which is what keeps the momentum
          on a phone and lets the remembered offset go on meaning something.

          Always rendered, and `display: contents` while the mode is off -- so it generates no box
          and the strip is laid out exactly as though it were still the scroller's own child.
          Rendering it conditionally reads tidier and was a real bug: it moves the strip in the
          tree, so React unmounts it and mounts a new one. That detached the element the
          ResizeObserver was watching, which then reported zero and undid the measurement; and it
          would remount every open session card inside the strip, standing up every stream on the
          canvas again on each toggle. Same trick, and the same reason, as `BotSessionCard`'s
          tasks host. */}
      <div style={zoom.sizerStyle}>{strip}</div>
    </div>
  );
}



