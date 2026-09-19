// One of a Bot's sessions, which is a Bot one level down.
//
// Its own file because an open one is not a preview of a session but a whole one -- the same
// `SessionView` the app's thread view renders, with its streams, its terminal and its composer --
// and that is a different thing from the Bot card that holds it.

import { Bot, ChevronDown } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionView, type SessionViewContext } from "@/features/session-view/SessionView";
import { FileDropOverlay, useFileDropTarget } from "@/features/session-view/fileDropTarget";
import { SessionMeta } from "@/features/sidebar/SessionMeta";
import { SessionAvatar } from "@/features/bots/SessionAvatar";
import { SessionRowMenu } from "@/features/bots/menus/SessionRowMenu";
import { useCardResize } from "@/features/bots/cards/useCardResize";
import type { BotCardSize } from "@/features/bots/botCanvasPreferences";
import { CLOSED_SESSION_WIDTH, sessionKey, type BotCommandError } from "@/features/bots/cards/botCanvasCards";
import { botSessionFaceRank, botSessionStyle } from "@/features/bots/botSurface";

/** How far a press has to travel before it stops being a click and becomes a carry. */
const MOVE_THRESHOLD = 4;

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
export function BotSessionCard({
  bot,
  session,
  hue,
  rank,
  shade,
  solo,
  open,
  onToggle,
  offset,
  lifted,
  onMoveStart,
  onMoveBy,
  onMoveEnd,
  onMoveBySteps,
  canMoveEarlier,
  canMoveLater,
  size,
  onResize,
  onResizeCommit,
  sessionContext,
  botError,
  onFork,
  onForkFromLastMessage,
  onForkFromLastCompaction,
  onRename,
  onDetach,
  onRemoveFromCanvas,
}: {
  bot: BotView;
  session: SessionSummary;
  /** The Bot's place on the colour wheel, which every one of its sessions shares. */
  hue: number | undefined;
  /** The Bot's rank in the creation order, which draws its sessions' faces. Beside the hue. */
  rank: number | undefined;
  /** This session's step on that Bot's shade ladder, which is what separates it from its siblings. */
  shade: number | undefined;
  /**
   * Whether this is the only session its Bot has, in which case it gets no rail.
   *
   * Over the Bot's durable roster rather than over what the canvas is showing, the same as the
   * shade is: a Bot with three sessions and two of them taken off the canvas has not become a Bot
   * with one, and a card that grew a rail because a sibling was hidden would be saying something
   * about the view rather than about the Bot.
   */
  solo: boolean;
  open: boolean;
  onToggle: () => void;
  /** How far this card is drawn from where the roster laid it out, while a move is happening. */
  offset: number;
  /** Whether this is the card being carried, rather than one stepping aside for it. */
  lifted: boolean;
  onMoveStart: (clientX: number) => void;
  onMoveBy: (clientX: number) => void;
  onMoveEnd: () => void;
  /** The keyboard's way to the same thing: one place earlier or later in the Bot's order. */
  onMoveBySteps: (steps: number) => void;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  size: BotCardSize;
  onResize: (size: BotCardSize) => void;
  onResizeCommit: (size: BotCardSize) => void;
  sessionContext: SessionViewContext;
  botError: BotCommandError | null;
  /** Absent on a Codex session: only the Claude CLI has a fork to ask for. */
  onFork?: () => void;
  /** The same fork, starting just before the last thing a person said. Codex-absent likewise. */
  onForkFromLastMessage?: () => void;
  onForkFromLastCompaction?: () => void;
  /** Absent on a Codex session, whose title this panel does not own. */
  onRename?: () => void;
  onDetach: () => void;
  /** Takes this card off the canvas. The Bot keeps the session, and the sidebar still lists it. */
  onRemoveFromCanvas: () => void;
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
  /**
   * What this card's session does with a dropped image, published up from inside it.
   *
   * Null while the card is closed -- the session's body is not mounted, so there is nothing to
   * publish -- and null while it is open on a session with no composer to paste into. Both are
   * refusals with different answers, which is why the message below distinguishes them.
   */
  const [acceptFiles, setAcceptFiles] = useState<((files: readonly File[]) => void) | null>(null);
  // Wrapped, because `setAcceptFiles` would take the accepting function as an updater and call it
  // with the previous value instead of storing it.
  const takeAcceptFiles = useCallback(
    (accept: ((files: readonly File[]) => void) | null) => setAcceptFiles(() => accept),
    [],
  );
  const drop = useFileDropTarget<HTMLDivElement>(acceptFiles);
  // Both or neither, decided in one place so the class and the properties cannot disagree: a card
  // wearing `bot-session-fill` with no `--bot-hue` would resolve the hue it inherited from the Bot
  // card around it and paint step zero of a ladder it is not on.
  const shaded = botSessionStyle(hue, shade);
  // The rail says which Bot a card belongs to, among the Bot's several. With one session there is
  // no "among", and a rail down the only thing in a container draws a line between a group and
  // itself. The card keeps its shade either way, so it still reads as a card sitting on its Bot.
  const railed = shaded !== undefined && !solo;
  // A press on this card's face is a click until it has travelled far enough to be a carry, the
  // same threshold and for the same reason as the Bot header one level up: without it a hand that
  // shifts two pixels while opening a session would reorder its Bot.
  //
  // On the BUTTON rather than on the row around it, which is the difference from that header. The
  // face is the only part of this row that is not already a control -- the session's own controls
  // and its menu sit beside it -- so it is the one thing there is to grab, and capturing the
  // pointer on the element the click will be dispatched to is what keeps the click working at all.
  const grab = useRef<{ pointerId: number; startX: number; carrying: boolean } | null>(null);
  const carried = useRef(false);
  const grabCard = (event: React.PointerEvent<HTMLButtonElement>): void => {
    // Cleared on the way IN rather than after a carry, so a drag that ended somewhere else does not
    // leave a flag behind to swallow the next tap.
    carried.current = false;
    grab.current = { pointerId: event.pointerId, startX: event.clientX, carrying: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const carryCard = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    if (!held.carrying) {
      if (Math.abs(event.clientX - held.startX) < MOVE_THRESHOLD) return;
      held.carrying = true;
      carried.current = true;
      onMoveStart(held.startX);
    }
    onMoveBy(event.clientX);
  };
  const dropCard = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const held = grab.current;
    if (!held || held.pointerId !== event.pointerId) return;
    grab.current = null;
    if (held.carrying) onMoveEnd();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };
  // A carry ends with a pointerup on this button, which the browser reports as a click; opening the
  // session there would mean every reorder also toggled the card it moved.
  const openUnlessCarried = (): void => {
    if (carried.current) return;
    onToggle();
  };
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
    <li
      className={`shrink-0 ${lifted ? "z-10" : ""}`}
      style={{
        width: open ? resize.width : CLOSED_SESSION_WIDTH,
        transform: offset === 0 ? undefined : `translateX(${offset}px)`,
        // The carried card tracks the pointer exactly; the ones stepping aside for it are the only
        // thing that should look like it is moving.
        transition: lifted ? undefined : "transform 150ms ease",
      }}
    >
      <div
        // `relative` so this card is what the session's tasks panel is positioned against. That
        // panel is absolutely placed against its nearest positioned ancestor, which without this
        // is the app itself -- and then every open session's panel lands in the same place. The
        // drop overlay below rides on the same property.
        //
        // `border-border` goes when the shade arrives, the same way the Bot card drops it: a
        // utility beats a component-layer class, so leaving it on would grey out the one edge that
        // says which session this is.
        //
        // Which is exactly what `border-primary` was doing, which is why a shaded card no longer
        // takes it at all. It sets all four colours from the utility layer, so an open card drew
        // itself `oklch(0.922 0 0)` on every edge -- a near-white neutral over the top of the Bot's
        // colour, measured on the live canvas -- and open is the state a card spends the most time
        // in and takes the most room in. The biggest thing on the canvas was the one thing on it
        // saying nothing about whose it was.
        //
        // Nothing is lost by dropping it, because the border was never what said "open". A card
        // that is open is several hundred pixels tall with a live transcript in it, its titlebar
        // is `session-view-header` where a closed one has no bar at all, and its chevron is
        // upside down. An unshaded card still takes primary, because there it has no hue to fall
        // back to and a plain `border-border` box would be the only open card that looked shut.
        className={`relative flex overflow-hidden rounded-lg border ${
          shaded
            ? `bot-session-edge bot-session-fill ${railed ? "bot-rail" : ""}`
            : open
              ? "border-primary"
              : "border-border"
        }`}
        style={{
          ...shaded,
          ...(open ? { height: resize.height } : null),
          // Inline because it has to beat Tailwind's `border` shorthand, which sets all four widths
          // from the utility layer. What is ON that edge changed with `bot-rail`: it used to be
          // this session's own step of the border ladder, so the one edge a reader starts from was
          // saying which session among several -- the question the fill and the other three borders
          // were already answering. It now carries the BOT's rail, the same colour and the same
          // solidity as the bar down the card around it, so the leading edge answers whose session
          // this is and the rest of the card answers which. Four pixels against the Bot card's six,
          // which is what puts the container's edge above the ones nested inside it.
          ...(railed ? { borderLeftWidth: 4 } : null),
        }}
        // The WHOLE card takes the file, titlebar included, and a closed one takes it too. The
        // session's own view is only the body and only while the card is open, so a handler down
        // there is missing from most of what a reader aims at -- including every card that is just
        // a name and a dot.
        {...drop.dropProps}
      >
        <div className="flex min-w-0 flex-1 flex-col">
          {/* A button cannot contain a button, so opening the session, its controls and its menu
              are siblings and the open tint moves up to the box that holds them -- the same shape
              the sidebar's rows took when they grew this menu. Open, this row is the session's
              titlebar: it is where its controls land, the way the app header is where the thread
              view's land.

              `session-view-header` rather than `bg-muted` resolves to `--muted` unless a shaded
              card published a colour, so an unshaded titlebar is the grey it always was. The
              tinted one is the only surface in the card that goes DARKER in dark and lighter in
              light: it carries the strongest tint AND the most readable text, and those want
              opposite directions in the two themes. `styles.css` carries the numbers. */}
          <div
            className={`@container flex shrink-0 flex-wrap items-start pr-1.5 ${
              open ? "session-view-header" : ""
            }`}
          >
            <button
              type="button"
              onClick={openUnlessCarried}
              onPointerDown={grabCard}
              onPointerMove={carryCard}
              onPointerUp={dropCard}
              onPointerCancel={dropCard}
              aria-expanded={open}
              // `cursor-pointer` rather than the header's `cursor-grab`, because unlike that header
              // this element's first job is opening the session; the grabbing cursor appears once a
              // press is actually being held, which is when it says something true.
              className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-start gap-2 py-2 pr-2 pl-1 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80 active:cursor-grabbing"
            >
              {/* The face, not a dot. A dot said live or not live and nothing about WHICH session
                  this was, so a Bot's roster opened with a column of identical marks. */}
              <SessionAvatar
                title={title}
                activity={session.activity}
                shaded={Boolean(shaded)}
                rank={rank !== undefined && shade !== undefined ? botSessionFaceRank(rank, shade) : undefined}
                className="mt-0.5"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
                  {title}
                </span>
                <SessionMeta
                  source={session.source}
                  lastEventAt={session.lastEventAt}
                  activity={session.activity}
                  worktree={session.worktree}
                />
              </span>
              <ChevronDown
                // Same ink as the caption under the title, for the same reason: it sits on the
                // card's fill, and the fill moves.
                className={`mt-0.5 size-4 shrink-0 session-muted-ink transition-transform ${open ? "rotate-180" : ""}`}
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
                onForkFromLastMessage={onForkFromLastMessage}
                onForkFromLastCompaction={onForkFromLastCompaction}
                onMoveEarlier={canMoveEarlier ? () => onMoveBySteps(-1) : undefined}
                onMoveLater={canMoveLater ? () => onMoveBySteps(1) : undefined}
                onDetach={onDetach}
                onRemoveFromCanvas={onRemoveFromCanvas}
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
            <section className="min-h-0 flex-1 border-t session-view-divider" aria-label={`${title} session`}>
              {/* The same component the app's own thread view renders, given a box instead of the
                  page. It needs nothing said to it about being small: everything in it measures the
                  column it is, so the box decides. */}
              <SessionView
                {...sessionContext}
                projectPath={bot.environment.path}
                session={session}
                controlsHost={controlsHost}
                tasksHost={tasksHost}
                onAcceptFiles={takeAcceptFiles}
              />
            </section>
          ) : null}
          {resize.bottom}
        </div>
        {/* `contents` so this box is not one: the panel inside it positions against the card. */}
        <div ref={setTasksHost} className="contents" />
        {resize.edge}
        {/* Last, and that is the point: the previous indication was an inset ring on the session's
            own root, which its transcript then painted over. A closed card can be opened, so it
            says so; a card with no composer to paste into cannot be helped that way. */}
        <FileDropOverlay
          dragging={drop.dragging}
          refusal={acceptFiles !== null
            ? null
            : open
              ? "This session has no composer to drop into"
              // Short because a closed card is one row tall and the overlay is clipped to it.
              : "Open to drop an image"}
        />
      </div>
    </li>
  );
}
