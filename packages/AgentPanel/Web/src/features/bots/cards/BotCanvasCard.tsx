// One Bot on the canvas: its head, its roster of sessions, and the grips that size it.
//
// The card grows to fit whatever session is open inside it rather than fitting that session into
// what it had left over, which is why the width and height it remembers are the CARD's and the
// open session's are its own. `BotSessionCard.tsx` holds the row this renders.

import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { AgentSessionDescriptor, BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import type { SessionViewContext } from "@/features/session-view/SessionView";
import { ActivityDot } from "@/features/sidebar/SessionMeta";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { BotAvatar } from "@/features/bots/avatar/BotAvatar";
import { SessionRowMenu } from "@/features/bots/menus/SessionRowMenu";
import { botSessionSlots, botSurfaceStyle } from "@/features/bots/botSurface";
import { useMissingSessionLog } from "@/features/bots/useMissingSessionLog";
import { canRenameSession } from "@/features/bots/sessionRename";
import { BotCardMenu } from "@/features/bots/menus/BotCardMenu";
import { BotCodeButton } from "@/features/bots/code/BotCodeButton";
import { BotGitButton } from "@/features/bots/git/BotGitButton";
import { useBotGitStatus } from "@/features/bots/git/useBotGitStatus";
import { BotNewSessionCard, type NewBotSession } from "@/features/bots/cards/BotNewSessionCard";
import { BotSessionCard } from "@/features/bots/cards/BotSessionCard";
import { DEFAULT_CARD_SIZE, type BotCardSize, type BotCardSizes } from "@/features/bots/canvas/botCanvasPreferences";
import { SESSION_GAP, sessionKey, type BotCommandError } from "@/features/bots/cards/botCanvasCards";
import { reorderSessionRefs } from "@/features/bots/cards/botSessionOrder";
import { useMoveAlongStrip } from "@/features/bots/canvas/useMoveAlongStrip";

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
  onHandoverToOpencode,
  onRenameSession,
  onDetachSession,
  onRemoveSessionFromCanvas,
  onDetachBot,
  onReorderSessions,
  scroller,
  newSessions,
  onCloseNewSession,
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
  onForkFromLastMessage: (session: SessionSummary, projectPath: string) => void;
  onForkFromLastCompaction: (session: SessionSummary, projectPath: string) => void;
  /** Opens the handover dialog for a Claude session. Absent as a capability elsewhere. */
  onHandoverToOpencode: (bot: BotView, session: SessionSummary) => void;
  /** Opens the rename dialog for this session. Claude only; a Codex row does not offer it. */
  onRenameSession: (session: SessionSummary) => void;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  /** Takes one session's card off the canvas; the Bot keeps the session either way. */
  onRemoveSessionFromCanvas: (session: BotSessionRef) => void;
  onDetachBot: (bot: BotView) => void;
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
  const projectName = bot.environment.path.split("/").filter(Boolean).at(-1) ?? bot.environment.path;
  // What the reader was shown, for the missing rows further down. The sidecar already says why a
  // reference went missing; this closes the chain by saying the row reached the screen, which is
  // the half that cannot be recovered from the sidecar's log after the fact.
  useMissingSessionLog(bot, "canvas-card");
  // One subscription for the header: the git button counts from it, and the code button re-reads
  // what it shows whenever it moves. From the card's own feed, because a peer's Bot is a directory
  // on the peer, and asking this Mac's git about it would answer about a path it may not have.
  const git = useBotGitStatus(
    sessionContext.feed,
    bot.botId,
    bot.environmentAvailability === "available",
  );
  // Dropped as soon as the Bot itself carries the session, rather than when the shell decides it
  // should be gone. The two happen a snapshot apart, and rendering both for that moment would put
  // two cards with one identity side by side.
  const starting = newSessions.filter(
    (each) => !bot.sessions.some((session) => session.sessionId === each.sessionId),
  );
  // The Bot's sessions this canvas is showing. Everything the card says about itself is said about
  // THESE rather than about the Bot: the count over an empty strip, the live dot that exists to
  // summarise the spines below it, and the scroll that brings a card forward when one of its own
  // opens. The ones that are off are named in the count's long form rather than dropped silently,
  // because the whole hazard of hiding something is a reader who has forgotten they hid it.
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
  const live = shown.filter((session) => session.activity === "live").length;
  const counted = `${shown.length} ${shown.length === 1 ? "session" : "sessions"}${
    live > 0 ? `, ${live} live` : ""
  }${hidden > 0 ? `, ${hidden} off the canvas` : ""}`;
  // Whether an open session is one of THIS card's, which is what the scroll below acts on.
  const holdsOpen = shown.some((session) => openKeys.has(sessionKey(session)));
  // Brings this card into view when it BECOMES an open one, because the row that opened it may
  // have been in the sidebar rather than on the canvas, and the card can be anywhere in a tiled
  // roster of thirty. `nearest` rather than `start`: it does nothing at all when the card is
  // already fully visible, which is the common case of clicking a row on the canvas itself, and a
  // card taller than the scroller aligns to its top under the same rule.
  //
  // The transition and not the state, which is the difference between this and what it replaced. A
  // card already open when it mounts is one the canvas is coming BACK to -- restored open keys, a
  // tab switched away from and returned to -- and scrolling to it there drags the strip off the
  // offset the reader left it at, with the last card to mount deciding where they land.
  const card = useRef<HTMLLIElement | null>(null);
  const wasOpen = useRef(holdsOpen);
  useEffect(() => {
    const opened = holdsOpen && !wasOpen.current;
    wasOpen.current = holdsOpen;
    if (!opened) return;
    card.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [holdsOpen]);
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
          className="flex w-0 min-w-full shrink-0 cursor-grab items-center gap-3 border-b border-border py-2 pr-3 pl-1 select-none active:cursor-grabbing"
          onPointerDown={grabHeader}
          onPointerMove={carryHeader}
          onPointerUp={dropHeader}
          onPointerCancel={dropHeader}
        >
          <BotAvatar bot={bot} hue={hue} rank={rank} size="size-11" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-(length:--agent-panel-fs-sidebar-body,15px) font-semibold text-foreground">
              {bot.name}
            </span>
            {/* The chip tier, not the meta tier, and that is the whole hierarchy fix on this card.
                This line is a caption bound to the name above it -- where the Bot runs and what it
                is pointed at -- while the session titles below it are the card's content, the
                thing a reader scans a canvas for. Both were 13px, so the only separation was
                weight and ink, and size was arguing against them: measured on the live canvas,
                "dev · agent-desk" and "AD Project manager" sat at the same optical level.
                11px also puts this line where the SIDEBAR has always drawn it, so one Bot now
                reads the same way in both places instead of two. */}
            <span className="block truncate text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
              {bot.metadata.role ? `${bot.metadata.role} · ` : ""}
              {machineLabel ? <span className="font-medium">{machineLabel}</span> : null}
              {machineLabel ? " · " : ""}
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
            <span aria-hidden>{shown.length}</span>
            <span className="sr-only">{counted}</span>
          </span>
          <BotCodeButton bot={bot} feed={sessionContext.feed} git={git} />
          <BotGitButton bot={bot} feed={sessionContext.feed} git={git} />
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
              <BotSessionCard
                key={sessionKey(session)}
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
                    ? () => onForkFromLastMessage(session, bot.environment.path)
                    : undefined
                }
                onForkFromLastCompaction={
                  session.source === "claude"
                    ? () => onForkFromLastCompaction(session, bot.environment.path)
                    : undefined
                }
                onHandoverToOpencode={
                  session.source === "claude"
                    ? () => onHandoverToOpencode(bot, session)
                    : undefined
                }
                onRename={
                  canRenameSession(session) ? () => onRenameSession(session) : undefined
                }
                // Every source: `/new` and `/fork` are opencode's, but a session made from any
                // session's composer belongs to the Bot whose card asked.
                onAttachSession={attachSessionToBot(bot)}
                onDetach={() => onDetachSession(bot, session)}
                onRemoveFromCanvas={() => onRemoveSessionFromCanvas(session)}
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
        )}

      </div>

    </li>
  );
}
