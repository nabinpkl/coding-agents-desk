// A session read in a modal, over whatever the main column is showing.
//
// The canvas owns the main column, so a session that is on no Bot -- picked from the Canvas tab's
// Sessions view -- opens here instead of replacing it, and so does a Bot's session maximized from
// its card. The same `SessionView` every other surface
// renders, with its own header for the controls it portals and its own box for files dropped on it.
//
// An overlay at z-40 rather than a `<dialog>` in the top layer: the session's popovers portal to
// the body at z-50, and anything outside the top layer paints under it whatever its z-index.

import { LayoutDashboard, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectSummary, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionView } from "@/features/session-view/SessionView";
import type { SessionViewContext } from "@/features/session-view/sessionTerminalTypes";
import { FileDropOverlay, useFileDropTarget } from "@/features/session-view/fileDropTarget";

/** Escape belongs to whatever is being typed in, which may be a session's own composer. */
function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable]") !== null);
}

export function SessionModal({
  context,
  project,
  session,
  onClose,
  onMoveToCanvas,
  botId,
  listed = true,
}: {
  context: SessionViewContext;
  project: ProjectSummary;
  session: SessionSummary;
  onClose: () => void;
  /**
   * Puts the session on its directory's Bot, made for it when there is none. Absent for a session a
   * Bot already holds, which is on the canvas already.
   */
  onMoveToCanvas?: (session: SessionSummary) => Promise<void>;
  /**
   * The Bot this session was maximized from. A fork from one of its messages names that Bot, so it
   * lands as a card beside this session's, the same as a fork from the card itself.
   */
  botId?: string;
  /** False for a session the catalog has not listed yet; see `SessionView`'s prop of the name. */
  listed?: boolean;
}) {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  const [controlsHost, setControlsHost] = useState<HTMLDivElement | null>(null);
  const [tasksHost, setTasksHost] = useState<HTMLDivElement | null>(null);
  const [acceptFiles, setAcceptFiles] = useState<((files: readonly File[]) => void) | null>(null);
  // Wrapped, because the setter would take the accepting function as an updater.
  const takeAcceptFiles = useCallback(
    (accept: ((files: readonly File[]) => void) | null) => setAcceptFiles(() => accept),
    [],
  );
  const drop = useFileDropTarget<HTMLDivElement>(acceptFiles);
  const contextFork = context.onForkFromMessage;
  const forkFromMessage = useMemo(
    () => contextFork === undefined || botId === undefined
      ? contextFork
      : (request: Parameters<typeof contextFork>[0]) => contextFork({ ...request, botId }),
    [botId, contextFork],
  );
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  // Closes on success, because the session's card is now open on the canvas behind this box. A
  // failure stays here, beside the button, since the canvas band is under the overlay.
  const moveToCanvas = async () => {
    if (!onMoveToCanvas) return;
    setMoving(true);
    setMoveError(null);
    try {
      await onMoveToCanvas(session);
      onClose();
    } catch (error) {
      setMoveError(error instanceof Error ? error.message : String(error));
      setMoving(false);
    }
  };

  // Focus moves in on open and back to whatever held it on close, the way a dialog's does.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => previous?.focus();
  }, []);

  // On the document rather than the overlay: on a phone the drawer this was picked from closes in
  // the same moment and hands focus back to its own trigger, outside this box, so a key handler
  // here would never hear the key.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isEditable(event.target)) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-2 sm:p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-[min(100%,56rem)] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl"
      >
        <header className="flex min-h-11 shrink-0 items-center gap-1 border-b border-border py-1 pr-1 pl-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-(length:--agent-panel-fs-sidebar-title,15px) font-semibold">
              {session.title || session.sessionId}
            </h2>
            <p className="truncate text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
              {project.displayName || project.projectPath}
            </p>
          </div>
          {onMoveToCanvas ? (
            <button
              type="button"
              onClick={() => void moveToCanvas()}
              disabled={moving}
              aria-busy={moving || undefined}
              className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {moving
                ? <LoaderCircle className="size-4 animate-spin" aria-hidden />
                : <LayoutDashboard className="size-4" aria-hidden />}
              Move to canvas
            </button>
          ) : null}
          <div ref={setControlsHost} className="flex shrink-0 items-center gap-1" />
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Close session"
            title="Close"
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        {moveError ? (
          <p role="alert" className="shrink-0 border-b border-border px-4 py-2 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
            Could not move this session to the canvas: {moveError}
          </p>
        ) : null}
        <div className="relative min-h-0 flex-1 bg-background" {...drop.dropProps}>
          <SessionView
            {...context}
            {...(forkFromMessage === undefined ? {} : { onForkFromMessage: forkFromMessage })}
            projectPath={project.projectPath}
            session={session}
            controlsHost={controlsHost}
            tasksHost={tasksHost}
            onAcceptFiles={takeAcceptFiles}
            listed={listed}
          />
          <FileDropOverlay
            dragging={drop.dragging}
            refusal={acceptFiles === null ? "This session has no composer to drop into" : null}
          />
        </div>
        {/* `contents`, so the tasks panel positions against this box rather than the page. */}
        <div ref={setTasksHost} className="contents" />
      </div>
    </div>,
    document.body,
  );
}
