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
import { useCallback, useEffect, useState } from "react";
import type { AgentSessionDescriptor, BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { useCardResize } from "@/features/bots/cards/useCardResize";
import { sessionKey, type BotCommandError } from "@/features/bots/cards/botCanvasCards";
import {
  clampFatherHeight,
  clampFatherWidth,
  loadFatherHeight,
  loadFatherWidth,
  storeFatherHeight,
  storeFatherWidth,
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
      id="father-home"
      aria-label="Father home"
      style={{ height: resize.height, width: resize.width }}
      className="fixed top-0 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-hidden rounded-b-2xl border-x border-b border-border bg-card shadow-2xl"
      {...drop.dropProps}
    >
      {/* A row rather than the header straight in the column, because the width grip hangs off
          the border the way a card's does: overlaid on the inside edge it would land on the
          transcript's scrollbar, and outside it there is nothing to grab. */}
      <div className="flex min-h-0 flex-1 flex-row">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-3">
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
