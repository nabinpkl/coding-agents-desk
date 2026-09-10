import { GitBranch } from "lucide-react";
import type { Bin } from "@agentdesk/agent-feed-wire";
import { SourceBadge } from "@/features/sidebar/SourceBadge";

/**
 * How a session reads at a glance: whether it is live, where it came from, when it last spoke.
 *
 * Extracted when the Bot canvas became the second surface to render it. The sidebar tree and the
 * canvas differ in density and in what wraps them, but the vocabulary a reader learns -- green
 * means live, the badge names the provider, the time is local -- has to be one thing, or the two
 * lists teach two.
 */
export function ActivityDot({ activity, className = "" }: { activity: Bin; className?: string }) {
  return (
    <span
      className={`size-2 shrink-0 rounded-full ${activity === "live" ? "bg-green-500" : "bg-muted-foreground/35"} ${className}`}
      aria-hidden
    />
  );
}

export function SessionMeta({
  source,
  lastEventAt,
  activity,
  worktree,
}: {
  source: string;
  lastEventAt: number;
  activity: Bin;
  /**
   * The git worktree this session works in, when that is not the directory it is listed under.
   *
   * Absent on almost every row, which is what makes it worth showing on the few where it is not:
   * a Bot can hold two sessions on one repository editing two branches, and they are otherwise
   * identical here down to the title.
   */
  worktree?: { path: string; branch: string | null };
}) {
  const time = new Date(lastEventAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <span className="mt-0.5 flex items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
      <SourceBadge source={source} />
      <span>{time}</span>
      <span className="capitalize">{activity}</span>
      {worktree ? (
        // Named rather than merely marked: "worktree" alone says a row is elsewhere without saying
        // where, which is the half of the answer a reader already had. A detached worktree has no
        // branch, so it falls back to the directory it is in -- still an answer, just a worse one.
        <span
          className="flex min-w-0 items-center gap-1 rounded bg-muted px-1 py-px font-medium"
          title={`Working in a git worktree at ${worktree.path}`}
        >
          <GitBranch className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{worktree.branch ?? basename(worktree.path)}</span>
        </span>
      ) : null}
    </span>
  );
}

/** The last segment of a path, for a detached worktree that has no branch to show instead. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}
