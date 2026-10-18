/**
 * The band that says something is still running.
 *
 * It sits in the bottom stack, above the composer, because that is where the eye already is while
 * reading a thread -- and because the fact it carries is about work the agent started and then
 * stopped talking about.
 *
 * Renders nothing when the count is zero. An idle session should not pay a band, and a chip that
 * is always present but usually says "0" trains people to stop seeing it.
 */

import { COLUMN_GUTTER_CLASS } from "@/features/activity-feed/blocks/ActivityEventHeading";
export function RunningTasksChip({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  if (count <= 0) return null;
  return (
    <div className={`flex shrink-0 items-center border-t session-view-dock ${COLUMN_GUTTER_CLASS} py-1`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${count} running ${count === 1 ? "task" : "tasks"}`}
        data-testid="running-tasks-chip"
        className="flex items-center gap-2 rounded-full px-2 py-1 text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {/* Two rings: a steady dot under a halo that pings a few times when the count changes and
            then rests. It used to ping forever, and an infinite animation keeps the compositor
            drawing a frame per refresh for as long as it runs -- measured 2026-10-05 on a canvas
            of six cards, three of these took the GPU process from about 2% of a core to 13%. Keyed
            on the count, so each change restarts it: the motion marks the change, and the dot
            says the work is still running. */}
        <span className="relative flex size-2.5 shrink-0 items-center justify-center">
          <span
            key={count}
            className="absolute inline-flex size-2.5 animate-ping rounded-full bg-amber-500 opacity-60 motion-reduce:animate-none"
            style={{ animationIterationCount: 3, animationFillMode: "forwards" }}
          />
          <span className="relative inline-flex size-1.5 rounded-full bg-amber-500" />
        </span>
        <span className="truncate">
          {count} running {count === 1 ? "task" : "tasks"}
        </span>
      </button>
    </div>
  );
}
