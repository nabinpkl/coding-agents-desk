// The line under a canvas session's title: what it is doing, then where and when.
//
// The sidebar's `SessionMeta` spends this line on the provider's name, the time and the activity
// in words. A card is narrow, and the most useful thing it can say under the title is what the
// session said it set out to do -- the `<task-state>` block it opened its last piece of handed-over
// work with -- so the rest gives up room: the provider shrinks to a letter whose hue still names
// it, "Cold" moves onto the face as sleeping Zs (`SessionAvatar`'s `sleeping`), and the time goes
// last, where a column of cards lines it up.
//
// The task is a control of its own: it opens the whole goal and the decisions under it, which is
// the reason the block exists -- seeing how the session set out without reading its transcript.
// A mouse opens it by resting on the task and closes it by leaving; a click pins it open. A finger
// has no hover, so on the phone a tap opens and closes it.

import { useEffect, useId, useRef, useState } from "react";
import type { Bin, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { WorktreeChip } from "@/features/sidebar/session-list/SessionMeta";

/** How long the details stay open after the mouse leaves, so it can cross to them. */
const HOVER_GRACE_MS = 150;

export function SessionCardMeta({
  source,
  lastEventAt,
  activity,
  worktree,
  taskState,
}: {
  source: string;
  lastEventAt: number;
  activity: Bin;
  worktree?: { path: string; branch: string | null };
  taskState?: SessionSummary["taskState"];
}) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const detailsId = useId();
  // Leaving the task for the details under it crosses a gap; a short grace keeps them open across it.
  const leaving = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stay = (): void => {
    if (leaving.current !== null) clearTimeout(leaving.current);
    leaving.current = null;
  };
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
  useEffect(() => stay, []);
  const time = new Date(lastEventAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const showing = (pinned || hovered) && taskState !== undefined;
  return (
    <div className="mt-0.5 text-(length:--agent-panel-fs-sidebar-chip,11px) session-muted-ink">
      <div className="flex min-w-0 items-center gap-1.5">
        <SourceBadge source={source} short />
        {taskState ? (
          // Content rather than a caption, so the title's ink rather than the muted one.
          // `pointer-events-auto` because the card's own open/close sits underneath this line.
          <button
            type="button"
            onClick={() => setPinned((was) => !was)}
            onPointerEnter={enter}
            onPointerLeave={leave}
            aria-expanded={showing}
            aria-controls={detailsId}
            className="pointer-events-auto min-w-0 flex-1 cursor-pointer truncate rounded-sm text-left text-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary"
          >
            {taskState.task}
          </button>
        ) : (
          <span className="flex-1" />
        )}
        {worktree ? <WorktreeChip worktree={worktree} /> : null}
        {/* Cold is on the face; a screen reader still hears it here, where it used to be said. */}
        {activity === "cold" ? <span className="sr-only">Cold</span> : <span className="capitalize">{activity}</span>}
        <span className="shrink-0 tabular-nums">{time}</span>
      </div>
      {showing ? (
        // Selectable and inert to the card underneath: reading it must not open or close the card.
        <div
          id={detailsId}
          onPointerEnter={enter}
          onPointerLeave={leave}
          className="pointer-events-auto mt-1 cursor-text select-text text-foreground"
        >
          <p className="text-pretty">{taskState.task}</p>
          {taskState.lines.length > 0 ? (
            <ul className="mt-0.5 list-disc pl-4">
              {taskState.lines.map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
