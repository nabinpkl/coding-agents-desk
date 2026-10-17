// The line under a canvas session's title: what it is doing, then where and when.
//
// The sidebar's `SessionMeta` spends this line on the provider's name, the time and the activity
// in words. A card is narrow, and the most useful thing it can say under the title is what the
// session said it set out to do -- the `<task-state>` block it opened its last piece of handed-over
// work with -- so the rest gives up room: the provider shrinks to a letter whose hue still names
// it, "Cold" moves onto the face as a "zzz" (`SessionAvatar`'s `sleeping`), and the time goes last,
// where a column of cards lines it up.

import type { Bin, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SourceBadge } from "@/features/sidebar/SourceBadge";
import { WorktreeChip } from "@/features/sidebar/session-list/SessionMeta";

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
  const time = new Date(lastEventAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-chip,11px) session-muted-ink">
      <SourceBadge source={source} short />
      {taskState ? (
        // Content rather than a caption, so the title's ink rather than the muted one. The
        // decisions under it ride along as the tooltip until the card has a place to open them.
        <span
          className="min-w-0 flex-1 truncate text-foreground"
          title={[taskState.task, ...taskState.lines.map((line) => `- ${line}`)].join("\n")}
        >
          {taskState.task}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {worktree ? <WorktreeChip worktree={worktree} /> : null}
      {/* Cold is on the face; a screen reader still hears it here, where it used to be said. */}
      {activity === "cold" ? <span className="sr-only">Cold</span> : <span className="capitalize">{activity}</span>}
      <span className="shrink-0 tabular-nums">{time}</span>
    </span>
  );
}
