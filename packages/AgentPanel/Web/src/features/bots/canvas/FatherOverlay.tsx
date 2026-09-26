// The Father home: one declared session, rendered as itself, floating over the canvas.
//
// A Bot names its Father by putting a `fatherSession` on its record in `bots.json`. This panel
// finds that reference, resolves it against the Bot's own sessions, and renders the SAME
// `SessionView` a card would: transcript, controls, terminal, composer. Not a preview of the
// session, the session -- which is why the pills this replaced had to go. A pill said "open"
// and then opened something somewhere else; the home IS the thing.
//
// An overlay rather than a band, because a band spends rows the cards do not get and moves the
// strip every time it opens: the reader's cards would jump down and back with each toggle. This
// drops from the viewport top like a drawer -- `fixed`, so it draws over the navbar instead of
// starting below it -- centered and narrower than the canvas, so the strip beside and below it
// stays visible and clickable while it is open.

import { Crown, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSessionDescriptor, BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { useCardResize } from "@/features/bots/cards/useCardResize";
import { sessionKey, type BotCommandError } from "@/features/bots/cards/botCanvasCards";
import {
  clampFatherHeight,
  clampFatherPosition,
  clampFatherWidth,
  loadFatherHeight,
  loadFatherPosition,
  loadFatherWidth,
  storeFatherHeight,
  storeFatherPosition,
  storeFatherWidth,
  type FatherPosition,
} from "@/features/bots/canvas/fatherPreferences";
import { FileDropOverlay, useFileDropTarget } from "@/features/session-view/fileDropTarget";
import { SessionView, type SessionViewContext } from "@/features/session-view/SessionView";

export type FatherResolution =
  | { bot: BotView; session: SessionSummary }
  | { bot: BotView; missing: BotSessionRef }
  | null;

/**
 * Which session the home shows, if any.
 *
 * The first Bot in canvas order that names one: two Fathers would be two homes, and the strip
 * already decided what "first" means. A reference the catalog has forgotten resolves as missing
 * rather than as nothing, because a Father that silently unnames itself is the home closing for
 * no reason the reader can see.
 */
export function resolveFather(bots: readonly BotView[]): FatherResolution {
  for (const bot of bots) {
    if (!bot.fatherSession) continue;
    const key = sessionKey(bot.fatherSession);
    const session = bot.sessions.find((each) => sessionKey(each) === key);
    if (session) return { bot, session };
    return { bot, missing: bot.fatherSession };
  }
  return null;
}

export function FatherButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  if (open) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={false}
      aria-expanded={false}
      aria-controls="father-home"
      title="Open the Father home: the declared session, over the canvas"
      className="absolute top-3 right-3 z-30 flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full border border-border bg-card/95 px-4 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold text-foreground shadow-lg backdrop-blur outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
    >
      <Crown className="size-4 shrink-0 text-primary" aria-hidden />
      Father
    </button>
  );
}

export function FatherOverlay({
  bots,
  sessionContextFor,
  attachSessionToBot,
  onDetachSession,
  botError,
  onClose,
}: {
  bots: BotView[];
  /** The context one card renders its session in, by Bot: a peer's Father reads peer-side. */
  sessionContextFor: (botId: string) => SessionViewContext;
  /** A function of the Bot: the overlay knows the session, only the canvas knows whose it is. */
  attachSessionToBot: (bot: BotView) => (session: AgentSessionDescriptor) => void | Promise<void>;
  onDetachSession: (bot: BotView, session: BotSessionRef) => void;
  /** A failure from editing a Bot, shown when it is about the Father session. */
  botError: BotCommandError | null;
  onClose: () => void;
}) {
  // Owned here rather than in the canvas, so a drag writes storage only on release: the overlay
  // follows the live values while they move, and the stored ones are the answers they settled on.
  const [height, setHeight] = useState(loadFatherHeight);
  const [width, setWidth] = useState(loadFatherWidth);
  // Null until the reader first carries the drawer: centered top is the default and needs
  // nothing stored. A stored answer survives resizes by being pulled back on screen, never by
  // being forgotten -- forgetting would reopen centered and strand nothing, but it would also
  // throw away an arrangement the reader made on purpose.
  const [position, setPosition] = useState<FatherPosition | null>(loadFatherPosition);
  const dims = useRef({ width, height });
  dims.current = { width, height };
  useEffect(() => {
    const onResize = (): void =>
      setPosition((placed) =>
        placed
          ? clampFatherPosition(placed, dims.current, { width: window.innerWidth, height: window.innerHeight })
          : placed
      );
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Where this session portals its control strip and its background-tasks panel: nodes of its
  // own, the way a card gives it, or two open surfaces would land both in the app's single host.
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null);
  const [tasksHost, setTasksHost] = useState<HTMLElement | null>(null);
  // Wrapped, because the setter would take the accepting function as an updater and call it with
  // the previous value instead of storing it.
  const [acceptFiles, setAcceptFiles] = useState<((files: readonly File[]) => void) | null>(null);
  const takeAcceptFiles = useCallback(
    (accept: ((files: readonly File[]) => void) | null) => setAcceptFiles(() => accept),
    [],
  );
  const drop = useFileDropTarget<HTMLDivElement>(acceptFiles);
  const resize = useCardResize({
    name: "Father home",
    noun: "card",
    size: { width, height },
    canResizeWidth: true,
    canResizeHeight: true,
    // Each dimension judged on its own, so a diagonal drag that crosses one bound still moves
    // freely on the other.
    onResize: (next) => {
      setWidth(clampFatherWidth(next.width));
      setHeight(clampFatherHeight(next.height));
    },
    onResizeCommit: (next) => {
      const committedWidth = clampFatherWidth(next.width);
      const committedHeight = clampFatherHeight(next.height);
      setWidth(committedWidth);
      setHeight(committedHeight);
      storeFatherWidth(committedWidth);
      storeFatherHeight(committedHeight);
    },
  });
  const resolved = resolveFather(bots);

  // Carrying the drawer by its header, the way a Bot card carries by its own: a press is a click
  // until it has travelled far enough to be a carry, and a press that began on a control belongs
  // to that control. The first carry captures where the drawer already stands -- centered top
  // included -- so it follows the hand from there instead of jumping to a stored answer.
  const MOVE_THRESHOLD = 4;
  const sectionRef = useRef<HTMLElement | null>(null);
  const carry = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    from: FatherPosition;
    carrying: boolean;
  } | null>(null);
  const viewport = typeof window === "undefined"
    ? { width: 1440, height: 900 }
    : { width: window.innerWidth, height: window.innerHeight };
  const placed = position
    ? clampFatherPosition(position, { width: resize.width, height: resize.height }, viewport)
    : null;
  const grabDrawer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea, [contenteditable='true']")) return;
    const at = sectionRef.current?.getBoundingClientRect();
    carry.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: placed ?? (at ? { x: at.left, y: at.top } : { x: 0, y: 0 }),
      carrying: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const carryDrawer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const held = carry.current;
    if (!held || held.pointerId !== event.pointerId) return;
    if (!held.carrying) {
      if (Math.abs(event.clientX - held.startX) < MOVE_THRESHOLD && Math.abs(event.clientY - held.startY) < MOVE_THRESHOLD) return;
      held.carrying = true;
    }
    setPosition(clampFatherPosition(
      { x: held.from.x + event.clientX - held.startX, y: held.from.y + event.clientY - held.startY },
      { width: resize.width, height: resize.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  };
  const dropDrawer = (event: React.PointerEvent<HTMLDivElement>): void => {
    const held = carry.current;
    if (!held || held.pointerId !== event.pointerId) return;
    carry.current = null;
    if (held.carrying) {
      const landed = clampFatherPosition(
        { x: held.from.x + event.clientX - held.startX, y: held.from.y + event.clientY - held.startY },
        { width: resize.width, height: resize.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPosition(landed);
      storeFatherPosition(landed);
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  // A drawer closes on Escape, the way a dialog does: it floats over the page rather than living
  // in it, so the keyboard needs the same way out the X gives the pointer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section
      ref={sectionRef}
      id="father-home"
      aria-label="Father home"
      style={{
        height: resize.height,
        width: resize.width,
        // An explicit stand once carried; centered top until then. `left-1/2` with the translate
        // centers, `left-0 top-0` with the numbers stands where the hand left it.
        ...(placed ? { left: placed.x, top: placed.y } : null),
      }}
      className={`fixed z-50 flex max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-b-2xl border-x border-b border-border bg-card shadow-2xl ${
        placed ? "left-0 top-0" : "left-1/2 top-0 -translate-x-1/2"
      }`}
      {...drop.dropProps}
    >
      {/* A row rather than the header straight in the column, because the width grip hangs off
          the border the way a card's does: overlaid on the inside edge it would land on the
          transcript's scrollbar, and outside it there is nothing to grab. */}
      <div className="flex min-h-0 flex-1 flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            onPointerDown={grabDrawer}
            onPointerMove={carryDrawer}
            onPointerUp={dropDrawer}
            onPointerCancel={dropDrawer}
            className="flex min-h-11 shrink-0 cursor-grab items-center gap-2 border-b border-border px-3 select-none active:cursor-grabbing"
          >
        <Crown className="size-4 shrink-0 text-primary" aria-hidden />
        <h2 className="shrink-0 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold text-foreground">
          Father
        </h2>
        {resolved && "session" in resolved ? (
          <span className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
            {resolved.session.title || resolved.session.sessionId}
          </span>
        ) : (
          <span className="min-w-0 flex-1" />
        )}
        {resolved && "session" in resolved ? <span ref={setControlsHost} className="flex shrink-0 items-center gap-1" /> : null}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the Father home"
          title="Close the Father home"
          className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>
      {resolved === null ? (
        <p className="px-3 py-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          No Bot names a Father session. Put a `fatherSession` on a Bot&apos;s record in
          `bots.json` and its session stands here.
        </p>
      ) : "missing" in resolved ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
          <p role="alert" className="text-(length:--agent-panel-fs-sidebar-meta,13px) text-foreground">
            {resolved.bot.name}&apos;s Father session is gone from the catalog
            <span className="font-mono"> ({sessionKey(resolved.missing)})</span>.
          </p>
          <button
            type="button"
            onClick={() => onDetachSession(resolved.bot, resolved.missing)}
            className="flex min-h-9 shrink-0 cursor-pointer items-center justify-center self-start rounded-lg border border-border px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
          >
            Detach it from {resolved.bot.name}
          </button>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <SessionView
            key={sessionKey(resolved.session)}
            {...sessionContextFor(resolved.bot.botId)}
            projectPath={resolved.bot.environment.path}
            session={resolved.session}
            controlsHost={controlsHost}
            tasksHost={tasksHost}
            onAcceptFiles={takeAcceptFiles}
            onAttachSession={attachSessionToBot(resolved.bot)}
            externalError={botError
                && botError.session !== null
                && botError.session === sessionKey(resolved.session)
              ? botError.message
              : null}
          />
          {/* `contents` so this box is not one: the panel inside it positions against the home. */}
          <div ref={setTasksHost} className="contents" />
          <FileDropOverlay
            dragging={drop.dragging}
            refusal={acceptFiles !== null
              ? null
              : "This session has no composer to drop into"}
          />
          </div>
        )}
        </div>
        {resize.edge}
      </div>
      {resize.bottom}
    </section>
  );
}
