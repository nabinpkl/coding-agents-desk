import { Bot, ChevronDown, LoaderCircle, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionView, type SessionViewContext } from "@/features/session-view/SessionView";
import { FileDropOverlay, useFileDropTarget } from "@/features/session-view/fileDropTarget";
import { ActivityDot, SessionMeta } from "@/features/sidebar/SessionMeta";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { BotAvatar } from "@/features/bots/BotSidebarPanel";
import {
  DEFAULT_CARD_SIZE,
  botCanvasOrderOf,
  loadBotCanvasOrder,
  loadCanvasScroll,
  loadSessionCardSizes,
  moveInOrder,
  orderBotsForCanvas,
  storeBotCanvasOrder,
  storeCanvasScroll,
  storeSessionCardSizes,
  type BotCardSize,
  type BotCardSizes,
  type CanvasScroll,
} from "@/features/bots/botCanvasPreferences";
import { botSurfaceStyle } from "@/features/bots/botSurface";
import { botsOnShownMachines } from "@/features/bots/botMachines";
import { BotCardMenu } from "@/features/bots/menus/BotCardMenu";
import { BotNewSessionCard, type NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import { SessionRowMenu } from "@/features/bots/menus/SessionRowMenu";
import { BotCanvasCard, CanvasNotice } from "@/features/bots/cards/BotCanvasCard";
import { sessionKey, STRIP_GAP, type BotCommandError } from "@/features/bots/cards/botCanvasCards";
import { useRememberedCanvasScroll } from "@/features/bots/useRememberedCanvasScroll";
import { useMoveAlongStrip } from "@/features/bots/useMoveAlongStrip";

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
  detachedCount,
  detachedSessionKeys,
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
      detachedSessionKeys={detachedSessionKeys}
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
  detachedSessionKeys,
  openKeys,
  onToggleSession,
  newSessions,
  onCloseNewSession,
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
  detachedSessionKeys: ReadonlySet<string>;
  openKeys: ReadonlySet<string>;
  onToggleSession: (key: string) => void;
  newSessions: readonly NewBotSession[];
  onCloseNewSession: (sessionId: string) => void;
}) {
  // Every Bot's card size, read once at mount and written on release rather than on every pointer
  // move, so a drag is one storage write.
  const [sessionSizes, setSessionSizes] = useState<BotCardSizes>(loadSessionCardSizes);
  const [order, setOrder] = useState<string[]>(loadBotCanvasOrder);
  const arranged = orderBotsForCanvas(bots, order);
  // Hidden machines drop out HERE rather than upstream, because hiding one is a question about what
  // this strip shows and not about which Bots exist: the sidebar roster still lists every one, and
  // its chip still says how many each machine is holding back. Shared with the sidebar's status
  // rather than written twice, because that status counts exactly these.
  const standing = botsOnShownMachines(arranged, hiddenMachines, keyOfBot);
  const labelOf = (botId: string): string | undefined => {
    const key = keyOfBot(botId);
    return key === undefined ? undefined : machines.find((machine) => machine.key === key)?.label;
  };
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
  // A session taken off the canvas has no card either, so its failure goes to the band as well --
  // otherwise removing a hidden session from its Bot and failing would report to nobody.
  const carried = botError !== null && botError.session !== null
    && !detachedSessionKeys.has(botError.session)
    && standing.some((bot) => bot.sessions.some((each) => sessionKey(each) === botError.session));
  const orphanedError = botError !== null && !carried ? botError.message : null;
  const rememberScroll = useRememberedCanvasScroll(canvas, standing);
  return (
    <div
      ref={canvas}
      onScroll={rememberScroll}
      // The margin is the SCROLLER's rather than padding on the strip inside it, so the gutter
      // holds while the canvas is scrolled: cards enter and leave at the inset edge instead of
      // running to the window's, and the strip reads as a region with room around it rather than
      // as content pressed against the panel. It is horizontal only -- the vertical run is what
      // the cards are measured in, and the bar this surface no longer draws already gave it back.
      className="mx-4 h-full overflow-auto overscroll-contain"
    >
      {machineErrors.map(({ label, reason }) => (
        <div
          key={label}
          role="status"
          className="mx-3 mt-3 rounded-lg border border-border bg-muted/60 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
        >
          {label} is not answering, so its Bots are not on the canvas: {reason}
        </div>
      ))}
      {/* A canvas emptied by the chips above rather than by having no Bots. Without this the strip
          is simply blank, and the two look identical to a reader who has forgotten pressing one. */}
      {standing.length === 0 && arranged.length > 0 ? (
        <div
          role="status"
          className="mx-3 mt-3 rounded-lg border border-border bg-muted/60 px-3 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground"
        >
          {arranged.length} {arranged.length === 1 ? "Bot is" : "Bots are"} on machines you have
          hidden. The machines are in the sidebar's Canvas roster, above the Bots.
        </div>
      ) : null}
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
            newSessions={newSessions.filter((each) => each.botId === bot.botId)}
            onCloseNewSession={onCloseNewSession}
          />
        ))}
      </ul>
    </div>
  );
}



