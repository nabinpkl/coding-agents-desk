import { useRef, useState } from "react";
import type { AgentSessionDescriptor, BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import {
  loadSessionCardSizes,
  storeSessionCardSizes,
  type BotCardSize,
  type BotCardSizes,
} from "@/features/bots/canvas/botCanvasPreferences";
import { botsOnShownMachines } from "@/features/bots/botMachines";
import type { NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import { BotCanvasCard } from "@/features/bots/cards/BotCanvasCard";
import { CanvasNotices } from "@/features/bots/cards/canvasNotices";
import { sessionKey, type BotCommandError } from "@/features/bots/cards/botCanvasCards";
import { useRememberedCanvasScroll } from "@/features/bots/canvas/useRememberedCanvasScroll";
import { useMoveAlongStrip } from "@/features/bots/canvas/useMoveAlongStrip";
import { useCanvasZoom } from "@/features/bots/canvas/useCanvasZoom";

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
export function BotCanvasList({
  bots,
  hues,
  ranks,
  sessionContextFor,
  machines,
  keyOfBot,
  hiddenMachines,
  machineErrors,
  botError,
  onAddSession,
  onForkSession,
  attachSessionToBot,
  onForkFromLastMessage,
  onForkFromLastCompaction,
  onHandoverToOpencode,
  onRenameSession,
  onDetachSession,
  onRemoveSessionFromCanvas,
  onDetachBot,
  onSetFatherSession,
  onRenameBot,
  onDeleteBot,
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
  /** The ranks the card avatars draw their faces from. See the canvas above. */
  ranks: ReadonlyMap<string, number>;
  /** See `BotCanvas`: one context per Bot, because a Bot can be on another machine. */
  sessionContextFor: (botId: string) => SessionViewContext;
  /** See `BotCanvas`: the chip row, and which machine each card is on. */
  machines: readonly { key: string; label: string }[];
  keyOfBot: (botId: string) => string | undefined;
  hiddenMachines: ReadonlySet<string>;
  machineErrors: readonly { label: string; reason: string }[];
  botError: BotCommandError | null;
  onAddSession: (bot: BotView) => void;
  onForkSession: (bot: BotView, session: SessionSummary) => void;
  attachSessionToBot: (bot: BotView) => (session: AgentSessionDescriptor) => void | Promise<void>;
  /** The same fork, starting just before the last thing a person said in that session. */
  onForkFromLastMessage: (session: SessionSummary, projectPath: string) => void;
  onForkFromLastCompaction: (session: SessionSummary, projectPath: string) => void;
  onHandoverToOpencode: (bot: BotView, session: SessionSummary) => void;
  /** Opens the rename dialog for this session. Claude only; a Codex row does not offer it. */
  onRenameSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  onRemoveSessionFromCanvas: (session: BotSessionRef) => void;
  onDetachBot: (bot: BotView) => void;
  /** Names a session the Bot's Father, or clears it with a null ref. */
  onSetFatherSession: (bot: BotView, session: BotSessionRef | null) => void;
  /** Opens the dialog that renames a Bot and restyles its face. */
  onRenameBot: (bot: BotView) => void;
  /** Forgets a Bot; its sessions survive. */
  onDeleteBot: (bot: BotView) => void;
  onReorderSessions: (bot: BotView, sessionRefs: BotSessionRef[], moved: BotSessionRef) => void;
  onMoveBot: (moved: string, target: string) => void;
  detachedSessionKeys: ReadonlySet<string>;
  openKeys: ReadonlySet<string>;
  onToggleSession: (key: string) => void;
  newSessions: readonly NewBotSession[];
  onCloseNewSession: (sessionId: string) => void;
  /** See `BotCanvas`: the whole strip drawn small enough to see at once. */
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
          rank={ranks.get(bot.botId)}
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
          attachSessionToBot={attachSessionToBot}
          onForkFromLastMessage={onForkFromLastMessage}
          onForkFromLastCompaction={onForkFromLastCompaction}
          onHandoverToOpencode={onHandoverToOpencode}
          onRenameSession={onRenameSession}
          onDetachSession={onDetachSession}
          onRemoveSessionFromCanvas={onRemoveSessionFromCanvas}
          onDetachBot={onDetachBot}
          onSetFatherSession={onSetFatherSession}
          onRenameBot={onRenameBot}
          onDeleteBot={onDeleteBot}
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
      //
      // `flex-1` rather than `h-full` because this scroller is no longer the column's only child:
      // the open Father home stands above it, and a full height here would push the strip past the
      // column's end instead of sharing it.
      className="mx-4 min-h-0 flex-1 overflow-auto overscroll-contain"
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
