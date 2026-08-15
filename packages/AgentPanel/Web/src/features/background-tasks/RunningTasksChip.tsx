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
export function RunningTasksChip({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  if (count <= 0) return null;
  return (
    <div className="flex shrink-0 items-center border-t border-border bg-card px-2 py-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${count} running ${count === 1 ? "task" : "tasks"}`}
        data-testid="running-tasks-chip"
        className="flex items-center gap-2 rounded-full px-2 py-1 text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {/* Two rings: a steady dot under a pulsing halo. Motion is the point -- it says work is
            happening now, which a static badge cannot. */}
        <span className="relative flex size-2.5 shrink-0 items-center justify-center">
          <span className="absolute inline-flex size-2.5 animate-ping rounded-full bg-amber-500 opacity-60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-amber-500" />
        </span>
        <span className="truncate">
          {count} running {count === 1 ? "task" : "tasks"}
        </span>
      </button>
    </div>
  );
}
