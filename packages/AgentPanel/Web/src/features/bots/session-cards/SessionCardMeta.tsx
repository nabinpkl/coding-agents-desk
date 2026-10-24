// The line under a canvas session's title: what it is doing, then where.
//
// A card is narrow, and the most useful thing it can say under the title is what the session said
// it set out to do -- the `<task-state>` block it opened its last piece of handed-over work with --
// so the rest gives up room: the provider shrinks to a letter whose hue still names it, and the
// activity is left to the face beside the title (a green ring while live, sleeping Zs while cold,
// `SessionAvatar`). It carries no time, on the owner's word (2026-10-23), and neither do the
// sidebar's session rows (`SessionMeta`).
//
// The task is a control of its own: it opens the whole goal and the decisions under it, which is
// the reason the block exists -- seeing how the session set out without reading its transcript.
// A mouse opens it by resting on the task and closes it by leaving; a click pins it open. A finger
// has no hover, so on the phone a tap opens and closes it.
//
// It opens as a popover over the canvas rather than inside the card. Inside, it grew the card's
// header, so resting on a task shrank the transcript under it and pushed every row below; and the
// card clips what it holds, so it could not reach past a closed card's one row anyway.
//
// Beside it, how the session's latest turn stands: its `<spoken-status>` block, or the question it
// waits on (the same lines the audio channel says). The chip names the most pressing kind, in the
// attention colour when the session needs the person and the destructive one when something failed,
// so a Bot that is waiting stands out across the canvas; it opens to every line the same way.

import { useCallback, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Bin, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { WorktreeChip } from "@/features/sidebar/session-list/SessionMeta";
import { placePopup, triggerIsVisible, type Placement } from "@/features/bots/menus/anchoredPlacement";
import { useDismissOnOutsidePress, useOverlayPlacement } from "@/hooks/dom/overlays";
import { useEventListener } from "@/hooks/dom/useEventListener";
import { SPOKEN_KIND_INK, SPOKEN_KIND_LABEL, SPOKEN_KIND_ORDER } from "@/features/activity-feed/markdown/replyReports";
import { useStateFor } from "@/hooks/state/useStateFor";
import { useUnmountEffect } from "@/hooks/useMountEffect";

/** How long the popover stays after the mouse leaves, so the mouse can cross onto it. */
const HOVER_GRACE_MS = 150;

export function SessionCardMeta({
  source,
  activity,
  worktree,
  taskState,
  spokenStatus,
}: {
  source: string;
  activity: Bin;
  worktree?: { path: string; branch: string | null };
  taskState?: SessionSummary["taskState"];
  spokenStatus?: SessionSummary["spokenStatus"];
}) {
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-chip,11px) session-muted-ink">
      <SourceBadge source={source} />
      {taskState ? <TaskButton taskState={taskState} /> : <span className="flex-1" />}
      {spokenStatus ? <StatusButton status={spokenStatus} /> : null}
      {worktree ? <WorktreeChip worktree={worktree} /> : null}
      {/* The face says it; a screen reader, which is not shown the face, still hears it here. */}
      <span className="sr-only">{activity}</span>
    </div>
  );
}

function TaskButton({ taskState }: { taskState: NonNullable<SessionSummary["taskState"]> }) {
  return (
    <MetaPopover
      label="What this session set out to do"
      // At the title's size rather than the caption's: it is the line a reader came to read.
      triggerClassName="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-meta,13px) text-foreground"
      trigger={taskState.task}
    >
      <p className="font-medium text-pretty">{taskState.task}</p>
      {taskState.lines.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
          {taskState.lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : null}
    </MetaPopover>
  );
}

type SpokenStatus = NonNullable<SessionSummary["spokenStatus"]>;

function StatusButton({ status }: { status: SpokenStatus }) {
  const kind = SPOKEN_KIND_ORDER.find((one) => status.lines.some((line) => line.kind === one)) ?? "note";
  const label = status.from === "question" ? "Asks you" : SPOKEN_KIND_LABEL[kind];
  return (
    <MetaPopover
      label="How this session's latest turn stands"
      triggerClassName={`shrink-0 ${SPOKEN_KIND_INK[kind]}`}
      trigger={label}
    >
      <ul className="space-y-1">
        {status.lines.map((line, index) => (
          <li key={index} className="text-pretty">
            <span className={SPOKEN_KIND_INK[line.kind]}>
              {status.from === "question" ? "Asks you" : SPOKEN_KIND_LABEL[line.kind]}:
            </span>{" "}
            {line.text}
          </li>
        ))}
      </ul>
    </MetaPopover>
  );
}

/** A piece of the meta line that opens a popover: on hover for a mouse, pinned by a click or a tap. */
function MetaPopover({
  label,
  trigger: triggerContent,
  triggerClassName,
  children,
}: {
  label: string;
  trigger: React.ReactNode;
  triggerClassName: string;
  children: React.ReactNode;
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const popupId = useId();
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showing = pinned || hovered;
  /** Null until the layout pass has measured; the popover stays invisible until then. Dropped on
   * close, so a popover reopened after the page moved is never placed from before. */
  const [placement, setPlacement] = useStateFor<Placement | null>(showing, () => null);

  const stay = useCallback((): void => {
    if (leaving.current !== null) clearTimeout(leaving.current);
    leaving.current = null;
  }, []);
  const close = useCallback((): void => {
    stay();
    setPinned(false);
    setHovered(false);
  }, [stay]);
  const enter = (event: React.PointerEvent): void => {
    if (event.pointerType !== "mouse") return;
    stay();
    setHovered(true);
  };
  const leave = (event: React.PointerEvent): void => {
    if (event.pointerType !== "mouse") return;
    stay();
    leaving.current = setTimeout(() => setHovered(false), HOVER_GRACE_MS);
  };
  useUnmountEffect(stay);

  const reposition = useCallback(() => {
    const button = trigger.current;
    const box = popup.current;
    if (!button || !box) return;
    // The task it explains has been scrolled out from under it, so there is nothing to explain.
    if (!triggerIsVisible(button)) {
      close();
      return;
    }
    setPlacement(placePopup(button.getBoundingClientRect(), box.getBoundingClientRect(), "start"));
  }, [close, setPlacement]);

  // Before paint, so the popover is placed in the commit that opens it rather than a frame later.
  useOverlayPlacement(showing, () => reposition(), [reposition]);

  // A pinned popover closes the way a menu does: a press anywhere else, or Escape.
  useDismissOnOutsidePress(showing, [popup, trigger], close);
  useEventListener<KeyboardEvent>(showing ? document : null, "keydown", (event) => {
    if (event.key === "Escape") close();
  });

  return (
    <>
      {/* Content rather than a caption, so the title's ink rather than the muted one.
          `pointer-events-auto` because the card's own open/close sits underneath this line. */}
      <button
        ref={trigger}
        type="button"
        onClick={() => setPinned((was) => !was)}
        onPointerEnter={enter}
        onPointerLeave={leave}
        aria-expanded={showing}
        aria-controls={showing ? popupId : undefined}
        className={`pointer-events-auto cursor-pointer rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary ${triggerClassName}`}
      >
        {triggerContent}
      </button>
      {showing
        ? createPortal(
            <div
              ref={popup}
              id={popupId}
              role="dialog"
              aria-label={label}
              // For anything that asks "is the pointer still inside me" with a DOM containment test,
              // the way the row menus mark themselves: the portal is outside the card in the DOM.
              data-portal-menu=""
              onPointerEnter={enter}
              onPointerLeave={leave}
              style={{
                top: placement?.top ?? 0,
                left: placement?.left ?? 0,
                visibility: placement ? undefined : "hidden",
              }}
              className="fixed z-50 w-max max-w-80 cursor-text select-text rounded-lg border border-border bg-popover p-3 text-(length:--agent-panel-fs-sidebar-meta,13px) text-popover-foreground shadow-xl"
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
