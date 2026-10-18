// One Bot on the canvas: its head, its roster of sessions, and the grips that size it.
//
// The card grows to fit whatever session is open inside it rather than fitting that session into
// what it had left over, which is why the width and height it remembers are the CARD's and the
// open session's are its own. `BotSessionCard.tsx` holds the row this renders.

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentSessionDescriptor, BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import {
  FilePathOpenerContext,
  type FilePathOpener,
  type FilePathTarget,
} from "@/features/activity-feed/markdown/filePathLinks";
import { SessionRowMenu } from "@/features/bots/menus/SessionRowMenu";
import { BotCanvasHeader } from "@/features/bots/cards/BotCanvasHeader";
import { botSessionSlots, botSurfaceStyle } from "@/features/bots/botSurface";
import { useMissingSessionLog } from "@/features/bots/useMissingSessionLog";
import { canRenameSession } from "@/features/bots/sessionRename";
import { handoverMenuProp } from "@/features/bots/sessionHandover";
import { BotNewSessionCard, type NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import { BotForkDraftCard, type ForkDraftControls } from "@/features/bots/cards/BotForkDraftCard";
import { BotSessionCard } from "@/features/bots/cards/BotSessionCard";
import { DEFAULT_CARD_SIZE, type BotCardSize, type BotCardSizes } from "@/features/bots/canvas/botCanvasPreferences";
import { SESSION_GAP, sessionKey, type BotCommandError } from "@/features/bots/cards/botCanvasCards";
import { reorderSessionRefs } from "@/features/bots/cards/botSessionOrder";
import { isFatherSession } from "@/features/bots/botRosterOrder";
import { useMoveAlongStrip } from "@/features/bots/canvas/useMoveAlongStrip";
import { reachMilestone } from "@/features/telemetry/pageMilestones";
import { PanelErrorBoundary } from "@/app/PanelErrorBoundary";

export function BotCanvasCard({
  bot,
  hue,
  rank,
  sessionContext,
  botError,
  detachedSessionKeys,
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
  attachSessionToBot,
  onForkFromLastMessage,
  onForkFromLastCompaction,
  onHandoverSession,
  onRenameSession,
  onDetachSession,
  onRemoveSessionFromCanvas,
  onMaximizeSession,
  onDetachBot,
  onSetFatherSession,
  onRenameBot,
  onDeleteBot,
  onReorderSessions,
  scroller,
  newSessions,
  onCloseNewSession,
  forkDrafts,
  machineLabel,
}: {
  bot: BotView;
  /** This Bot's place on the colour wheel, or nothing if the roster does not know it yet. */
  hue: number | undefined;
  /** This Bot's rank in the creation order, or nothing where the hue is nothing. Draws the face. */
  rank: number | undefined;
  sessionContext: SessionViewContext;
  botError: BotCommandError | null;
  detachedSessionKeys: ReadonlySet<string>;
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
  attachSessionToBot: (bot: BotView) => (session: AgentSessionDescriptor) => void | Promise<void>;
  onForkFromLastMessage: (bot: BotView, session: SessionSummary) => void;
  onForkFromLastCompaction: (bot: BotView, session: SessionSummary) => void;
  /** Opens the handover dialog for a Claude session. Absent as a capability elsewhere. */
  onHandoverSession: (bot: BotView, session: SessionSummary) => void;
  /** Opens the rename dialog for this session. Claude only; a Codex row does not offer it. */
  onRenameSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  /** Takes one session's card off the canvas; the Bot keeps the session either way. */
  onRemoveSessionFromCanvas: (session: BotSessionRef) => void;
  /** Opens this session in the modal, over the canvas, without changing what the card shows. */
  onMaximizeSession: (bot: BotView, session: SessionSummary) => void;
  onDetachBot: (bot: BotView) => void;
  /** Names a session the Bot's Father, or clears it with a null ref. */
  onSetFatherSession: (bot: BotView, session: BotSessionRef | null) => void;
  /** Opens the dialog that renames this Bot and restyles its face. */
  onRenameBot: (bot: BotView) => void;
  /** Forgets this Bot; its sessions survive. */
  onDeleteBot: (bot: BotView) => void;
  /**
   * Stands this Bot's sessions in a new order, naming the one that was carried.
   *
   * The whole order rather than the move, because that is what the Bot is asked to hold and what
   * the sidecar checks against the references it has: see `botSessionOrder.ts` for the translation
   * from the cards on screen, which are only ever a subset of it.
   */
  onReorderSessions: (bot: BotView, sessionRefs: BotSessionRef[], moved: BotSessionRef) => void;
  /**
   * The canvas's own scroller, so a session carried to the edge of the panel makes it creep.
   *
   * The card cannot be it: a Bot card clips its overflow and never scrolls, so the roster inside it
   * is laid out in full and the thing that has to move is the surface underneath.
   */
  scroller: React.RefObject<HTMLDivElement | null>;
  /** This Bot's share of the sessions the panel has started, already filtered to it. */
  newSessions: readonly NewBotSession[];
  onCloseNewSession: (sessionId: string) => void;
  /** Every fork waiting on the canvas; this card draws its own Bot's. */
  forkDrafts: ForkDraftControls;
  /**
   * The machine this Bot's directory is on, or absent when the canvas is showing only one.
   *
   * Absent rather than always present, because a panel reading one sidecar is every panel until a
   * peer is declared, and writing "dev" on every card there names something the reader cannot be
   * confused about. When there ARE two, it is the first thing to say: a path like
   * `/home/ubuntu/projects/rags` does not say which `/home/ubuntu`.
   */
  machineLabel?: string;
}) {
  // What the reader was shown, for the missing rows further down. The sidecar already says why a
  // reference went missing; this closes the chain by saying the row reached the screen, which is
  // the half that cannot be recovered from the sidecar's log after the fact.
  useMissingSessionLog(bot, "canvas-card");
  // Dropped as soon as the Bot itself carries the session, rather than when the shell decides it
  // should be gone. The two happen a snapshot apart, and rendering both for that moment would put
  // two cards with one identity side by side.
  const starting = newSessions.filter(
    (each) => !bot.sessions.some((session) => session.sessionId === each.sessionId),
  );
  // The Bot's sessions this canvas is showing. Everything the card says about itself is said about
  // THESE rather than about the Bot: the empty-strip message, and the scroll that brings a card
  // forward when one of its own opens.
  const shown = bot.sessions.filter((session) => !detachedSessionKeys.has(sessionKey(session)));
  // The same split for a reference the catalog cannot resolve. The whole list used to render
  // regardless, so a session the reader had taken off this canvas came back as a `missing` row
  // occupying the card -- put there by a sidecar restart's half-reconciled catalog, which the reader
  // did not cause. A detached one is counted as off the canvas and left there.
  const shownMissing = bot.missingSessionRefs.filter(
    (ref) => !detachedSessionKeys.has(sessionKey(ref)),
  );
  const hidden = bot.sessions.length - shown.length
    + bot.missingSessionRefs.length - shownMissing.length;
  // Over the stored slots and not over `shown`, which is the whole reason it is computed here
  // rather than beside the filter above: the cards on screen are a subset twice over -- missing
  // transcripts and sessions taken off the canvas -- and ranking either subset would repaint the
  // rest of the roster whenever one left it. See `botSessionSlots`.
  const slots = useMemo(() => botSessionSlots(bot.sessionRefs, bot.sessionSlots), [bot.sessionRefs, bot.sessionSlots]);
  // A path a session names opens in this Bot's code dialog, read against the Bot's directory: the
  // sessions in a Bot run there, so that is what their relative paths are relative to.
  const [fileRequest, setFileRequest] = useState<FilePathTarget | null>(null);
  const directory = bot.environmentAvailability === "missing" ? null : bot.environment.path;
  const opener = useMemo<FilePathOpener | null>(
    () => (directory === null ? null : { root: directory, open: setFileRequest }),
    [directory],
  );
  // The same carry the strip does with Bot cards, one level down and over this Bot's own roster.
  // What it moves is the BOT's order rather than anything held here, so the drop translates the
  // positions on screen into the full order and hands that over; nothing local remembers it.
  const roster = useRef<HTMLUListElement | null>(null);
  const rearrangeSessions = (from: number, to: number): void => {
    const moved = reorderSessionRefs(bot.sessionRefs, shown, from, to);
    if (moved) onReorderSessions(bot, moved.sessionRefs, moved.moved);
  };
  const moveSession = useMoveAlongStrip({
    canvas: scroller,
    list: roster,
    gap: SESSION_GAP,
    // The Bot's own sessions and nothing after them. The starting cards and the missing references
    // are laid out in this same row and have no place in the order, so a card dropped on one would
    // be aimed at a position that cannot be expressed.
    count: shown.length,
    onDrop: rearrangeSessions,
  });
  // Brings this card into view when one of its sessions BECOMES open, because the row that opened
  // it may have been in the sidebar rather than on the canvas, and the card can be anywhere in a
  // tiled roster of thirty. `nearest` rather than `start`: it does nothing at all when the card is
  // already fully visible, which is the common case of clicking a row on the canvas itself, and a
  // card taller than the scroller aligns to its top under the same rule.
  //
  // The transition and not the state. A card already open when it mounts is one the canvas is
  // coming BACK to -- restored open keys, a tab switched away from and returned to -- and scrolling
  // to it there drags the strip off the offset the reader left it at, with the last card to mount
  // deciding where they land.
  //
  // And the transition of the KEY, not of the card holding one. A session leaves `shown` without
  // the reader closing it whenever the sidecar restarts: its catalog answers partially while it
  // reconciles, so the reference reads as missing for a moment and then comes back. Judged on the
  // card, that came back as a fresh open on every card at once, and the strip ended up at whichever
  // of them scrolled last (measured 2026-10-13 in the panel's scroll log: three `scrollIntoView`
  // calls within 500ms of the bots stream reconnecting, 336 -> 3984). So a key is announced once,
  // and forgotten only when the reader closes it.
  const card = useRef<HTMLLIElement | null>(null);
  const announced = useRef<ReadonlySet<string>>(openKeys);
  useEffect(() => {
    const before = announced.current;
    const opened = shown.some((session) => {
      const key = sessionKey(session);
      return openKeys.has(key) && !before.has(key);
    });
    const next = new Set([...before].filter((key) => openKeys.has(key)));
    for (const session of shown) {
      const key = sessionKey(session);
      if (openKeys.has(key)) next.add(key);
    }
    announced.current = next;
    if (!opened) return;
    card.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [openKeys, shown]);
  useEffect(() => reachMilestone("first-card"), []);
  // `bot-surface` sets the background and the border together, because a tinted card inside a
  // neutral border reads as a mistake rather than as a colour. A Bot the roster has not ranked
  // falls back to the plain card it was, which is defensive rather than expected: the canvas shows
  // a subset of the roster the hues are built from.
  // `bot-rail` is the second half of that: a solid bar of the Bot's colour down the leading edge,
  // which is where a card in a horizontal strip is read from. The tint alone was doing this job and
  // could only ever whisper it -- it is a large area with text on it, so it is bounded by contrast
  // -- while a rail carries nothing and is bounded only by the gamut. So the card says whose it is
  // twice, faintly over its whole body and unmistakably on one edge, and the sessions inside it
  // repeat the second half verbatim.
  const surface = hue === undefined ? "bg-card" : "bot-surface bot-rail";
  // A card being carried says something about right now, which outranks saying whose it is.
  const edge = lifted ? "z-10 border-primary shadow-xl" : hue === undefined ? "border-border" : "";
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
        // Inline because Tailwind's `border` sets all four widths from the utility layer, which
        // beats the component layer the rail's colour lives in whatever the source order. Six
        // against a session's four: the Bot is the container, and a container's edge reading
        // heavier than the edges inside it is what says which way the nesting goes. The ratio is
        // what carries that, not either number, so move them together.
        ...(hue === undefined ? null : { borderLeftWidth: 6 }),
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
        <BotCanvasHeader
          bot={bot}
          hue={hue}
          rank={rank}
          machineLabel={machineLabel}
          feed={sessionContext.feed}
          onMoveStart={onMoveStart}
          onMoveBy={onMoveBy}
          onMoveEnd={onMoveEnd}
          onMoveBySteps={onMoveBySteps}
          canMoveLeft={canMoveLeft}
          canMoveRight={canMoveRight}
          onAddSession={onAddSession}
          onDetachBot={onDetachBot}
          onRenameBot={onRenameBot}
          onDeleteBot={onDeleteBot}
          fileRequest={fileRequest}
          onCloseFile={() => setFileRequest(null)}
        />

        {shown.length === 0 && shownMissing.length === 0 && starting.length === 0 ? (
          <p className="px-3 py-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            {/* Not "No sessions attached", which would be false and would send the reader to Add
                sessions for sessions this Bot already has. The sidebar is where they went. */}
            {hidden > 0
              ? `${hidden === 1 ? "Its session is" : "All of its sessions are"} off the canvas`
              : "No sessions attached"}
          </p>
        ) : (
          // The one flexible thing in the card: closed rows keep their own height, so a drag lands
          // entirely on the open session. Squeezed hard enough the session collapses to nothing and
          // the roster stays readable, which is the recoverable way round -- drag it taller again.
          // A Bot's sessions stand SIDE BY SIDE, which is the same shape the canvas has one level
          // up: a strip of boxes each at its own width, and nothing wrapping out of it. A column
          // per session is what makes opening one a local act -- it grows downwards in its own
          // place while the rest keep theirs, instead of taking over the width of a list.
          <FilePathOpenerContext.Provider value={opener}>
            <ul
              ref={roster}
              role="list"
              aria-label={`${bot.name} sessions`}
              // The leading inset stays small on purpose. A session's rail sitting 8px inside
              // the Bot's read as one thick striped edge rather than as a bar inside a card --
              // two rails of the same colour that close together are one rail, and the nesting
              // they exist to show is the thing that goes missing. Eight here, on top of the
              // Bot's own six-pixel rail, leaves 14px of plain Bot surface before the first
              // session's edge, which is enough for the emptiness itself to say one contains
              // the other.
              //
              // The other three are ten, and they are not the same question. Nothing runs along
              // them, so all they have to do is show that the card sits ON the Bot rather than
              // being it. Sixteen did that and then kept going: on an open card, which fills its
              // Bot, the surplus reads as a band of Bot colour framing the transcript, and a band
              // is what a reader calls a border. Ten still shows the surface and stops there.
              //
              // A Bot is exactly as big as the sessions in it, so trimming this shrank the BOT card
              // and gave the transcript nothing. `DEFAULT_CARD_WIDTH` and `DEFAULT_CARD_HEIGHT` take
              // the difference back, which puts the Bot at the size it was and spends the trim on
              // the transcript. Move these numbers and move those.
              //
              // The gap between sessions is the larger number rather than the inset's, because it
              // separates two cards that each have a rail, where the inset separates a card from an
              // edge.
              className="flex items-start gap-4 p-2.5 pl-2"
            >
              {shown.map((session, index) => (
                // A session card that throws -- a transcript row the sidecar changed shape under --
                // costs that card, and its siblings and the Bot's own header keep working.
                <PanelErrorBoundary key={sessionKey(session)} surface="session card" compact listItem>
                  <BotSessionCard
                    bot={bot}
                    session={session}
                    offset={moveSession.offsetOf(index)}
                    lifted={moveSession.liftedIndex === index}
                    onMoveStart={(clientX) => moveSession.start(index, clientX)}
                    onMoveBy={moveSession.to}
                    onMoveEnd={moveSession.end}
                    onMoveBySteps={(steps) => rearrangeSessions(index, index + steps)}
                    canMoveEarlier={index > 0}
                    canMoveLater={index < shown.length - 1}
                    hue={hue}
                    rank={rank}
                    slot={slots.get(sessionKey(session))}
                    solo={bot.sessionRefs.length === 1}
                    open={openKeys.has(sessionKey(session))}
                    onToggle={() => onToggleSession(sessionKey(session))}
                    size={sessionSizes[sessionKey(session)] ?? DEFAULT_CARD_SIZE}
                    onResize={(next) => onResizeSession(sessionKey(session), next, false)}
                    onResizeCommit={(next) => onResizeSession(sessionKey(session), next, true)}
                    sessionContext={sessionContext}
                    botError={botError}
                    // The forks are Claude-only, and absent rather than inert on a Codex row: forking
                    // asks the Claude CLI for a branch it alone has. `canRenameSession` answers the
                    // same question for a title, and it is not Claude's alone.
                    onFork={
                      session.source === "claude" ? () => onForkSession(bot, session) : undefined
                    }
                    onForkFromLastMessage={
                      session.source === "claude"
                        ? () => onForkFromLastMessage(bot, session)
                        : undefined
                    }
                    onForkFromLastCompaction={
                      session.source === "claude"
                        ? () => onForkFromLastCompaction(bot, session)
                        : undefined
                    }
                    handover={handoverMenuProp(session, () => onHandoverSession(bot, session))}
                    onRename={
                      canRenameSession(session) ? () => onRenameSession(session) : undefined
                    }
                    // Every source: `/new` and `/fork` are opencode's, but a session made from any
                    // session's composer belongs to the Bot whose card asked.
                    onAttachSession={attachSessionToBot(bot)}
                    onDetach={() => onDetachSession(bot, session)}
                    onRemoveFromCanvas={() => onRemoveSessionFromCanvas(session)}
                    onMaximize={() => onMaximizeSession(bot, session)}
                    isFather={isFatherSession(bot, session)}
                    onSetFather={() => onSetFatherSession(bot, session)}
                    onClearFather={() => onSetFatherSession(bot, null)}
                  />
                </PanelErrorBoundary>
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
              {/* Beside the starting cards, where the fork will land once it starts: sending turns
                  this card into one of those without moving it. */}
              {forkDrafts.drafts.filter((draft) => draft.request.botId === bot.botId).map((draft) => (
                <BotForkDraftCard
                  key={draft.key}
                  draft={draft}
                  anchor={bot.nextAnchor}
                  onStart={(choices) => forkDrafts.start(draft.key, choices)}
                  onClose={() => forkDrafts.close(draft.key)}
                />
              ))}
              {/* Shown rather than hidden: a curated reference whose transcript the catalog has
                  forgotten is the row a reader most needs to see, and removing it is the Bots view's
                  job, not this one's. Only the ones this canvas is showing, though -- a reference the
                  reader took off it is counted in `hidden` above, like any other session they put
                  away. */}
              {shownMissing.map((ref) => (
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
          </FilePathOpenerContext.Provider>
        )}

      </div>

    </li>
  );
}
