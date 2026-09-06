import type { Bin } from "@agentdesk/agent-feed-wire";
import { SourceBadge } from "./SourceBadge";

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
}: {
  source: string;
  lastEventAt: number;
  activity: Bin;
}) {
  const time = new Date(lastEventAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <span className="mt-0.5 flex items-center gap-1.5 text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
      <SourceBadge source={source} />
      <span>{time}</span>
      <span className="capitalize">{activity}</span>
    </span>
  );
}
