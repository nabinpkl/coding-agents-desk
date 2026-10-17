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
// hangs from below its switch like a drawer -- `fixed`, so the strip does not move when it opens
// -- pinned to the right and narrower than full width, so the page beside and below it stays
// visible and clickable while it is open. It used to drop from the top of the window instead, over
// the navbar, because the switch left the screen as it opened and there was nothing to cover. It
// lives in the app shell rather than on one surface, so it is there on every view, not just the
// canvas. The window itself -- carried, resized, kept on screen -- is `FloatingWindow`, which an
// arena run's judge floats in too.

import { Crown } from "lucide-react";
import { useCallback, useState } from "react";
import type { AgentSessionDescriptor, BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { sessionKey, type BotCommandError } from "@/features/bots/cards/botCanvasCards";
import { FATHER_WINDOW } from "@/features/bots/canvas/fatherPreferences";
import { FloatingWindow } from "@/features/floating-window/FloatingWindow";
import { FileDropOverlay, useFileDropTarget } from "@/features/session-view/fileDropTarget";
import { SessionView, type SessionViewContext } from "@/features/session-view/SessionView";

export type FatherResolution =
  | { bot: BotView; session: SessionSummary }
  | { bot: BotView; missing: BotSessionRef }
  | null;

/**
 * Which session the home shows, if any.
 *
 * There is one Father: a sidecar clears its other Bots' Fathers in the write that names one, and
 * the panel clears other machines' after it. First in canvas order is only the answer for the
 * moment between those two writes, when the strip already decided what "first" means. A reference the catalog has forgotten resolves as missing
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

/**
 * The switch that opens and puts away the home.
 *
 * A toggle and always on screen, rather than a control that exists only while the home is shut.
 * A switch that vanishes the moment it is used leaves the reader with no way back to it and no
 * sign of what is running: the home's own X and the Escape key both close it, so the state was
 * legible either way, but neither of those says "Father" on the page. Standing there while the
 * drawer is open takes the corner the drawer used to drop into, so the drawer now hangs from below
 * the switch instead -- which also leaves the bar's other controls reachable while it is open.
 */
export function FatherButton({ open, onToggle, floating = true }: {
  open: boolean;
  onToggle: () => void;
  /** Floating over the view when it has no header to stand in; inline in the header otherwise. */
  floating?: boolean;
}) {
  // The state in the border and the label rather than a filled background: the floating variant's
  // own surface is a translucent card over whatever is behind it, and a fill would have to fight it.
  // Hover stays a tint either way, so an open switch still answers the pointer.
  const state = open
    ? "border-primary/60 text-primary hover:bg-muted/70 hover:text-primary"
    : "border-border text-foreground hover:bg-muted hover:text-foreground";
  return (
    <button
      type="button"
      onClick={onToggle}
      // `aria-controls` finally points at something: while the home was shut-only there was never
      // an element by that id to point at.
      aria-expanded={open}
      aria-controls="father-home"
      title={open
        ? "Put the Father home away"
        : "Open the Father home: the declared session, over the panel"}
      className={floating
        ? `absolute top-3 right-3 z-30 flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full border bg-card/95 px-4 text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold shadow-lg backdrop-blur outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 ${state}`
        : `flex min-h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full border bg-card px-3 text-(length:--agent-panel-fs-sidebar-meta,13px) font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 ${state}`}
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
  const drop = useFileDropTarget<HTMLElement>(acceptFiles);
  const resolved = resolveFather(bots);

  // It closes on Escape and on a press outside it (FloatingWindow): the strip beside and below
  // stays visible and clickable while the home is open, and reaching for any of it puts the home
  // away.
  return (
    <FloatingWindow
      id="father-home"
      label="Father home"
      preferences={FATHER_WINDOW}
      closeLabel="Close the Father home"
      onClose={onClose}
      sectionProps={drop.dropProps}
      header={
        <>
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
        </>
      }
    >
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
          {/* A detach that failed says so here rather than nowhere: the missing paragraph above
              owns the alert role, so this is text beside it, shown only when it is about this
              same forgotten session. */}
          {botError && botError.session === sessionKey(resolved.missing) ? (
            <p className="text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
              {botError.message}
            </p>
          ) : null}
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
    </FloatingWindow>
  );
}
