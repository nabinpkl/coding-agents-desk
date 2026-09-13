import type { ActivityBlock, ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

export type DisplayItem =
  | { kind: "user"; ev: ActivityEvent }
  | { kind: "segment_event"; ev: ActivityEvent; isFirst: boolean; isLast: boolean }
  | { kind: "compaction"; ev: ActivityEvent }
  /** A folded run of consecutive tool calls and results, one row for all of them. */
  | { kind: "cluster"; events: ActivityEvent[] };

/**
 * Every event a row stands for, in order.
 *
 * A cluster is the first display item that is not one event, which ends the 1:1
 * items-to-events correspondence four other things were reading directly off `ev`.
 * They go through this and `leadEvent` instead, so adding another multi-event row
 * later does not have to find them again.
 */
export function itemEvents(item: DisplayItem): ActivityEvent[] {
  return item.kind === "cluster" ? item.events : [item.ev];
}

/**
 * The event a row is addressed by: its first.
 *
 * Used for the collapse set, the jump-to-row highlight and the row key. A cluster's
 * members have no row of their own while it is folded, so none of their indices can
 * collide with this one.
 */
export function leadEvent(item: DisplayItem): ActivityEvent {
  return item.kind === "cluster" ? item.events[0]! : item.ev;
}

/** Stable identity for the virtualizer's measurement cache. */
export function itemKey(item: DisplayItem): string {
  if (item.kind !== "cluster") return `${item.kind}-${item.ev.index}`;
  // Both ends, because expanding a neighbouring cluster can change where this one
  // starts without changing where it ends, and a key that moved would drop the
  // cached measurement and re-measure the whole window.
  const events = item.events;
  return `cluster-${events[0]!.index}-${events[events.length - 1]!.index}`;
}

export type DisplayRole =
  | "user"
  | "assistant"
  | "tool"
  | "result"
  | "reasoning"
  | "system";

// Metadata never disqualifies an event from its shape: the adapters append a
// Working Directory block to nearly every Claude line, so demanding blocks be
// *only* compaction plus raw meant no Claude compaction ever rendered as a
// banner. Same trap as isResultOnly in ActivityFeed.
function isCompactionEvent(ev: ActivityEvent): boolean {
  return ev.blocks.some((block) => block.kind === "compaction") &&
    ev.blocks.every(
      (block) =>
        block.kind === "compaction" ||
        block.kind === "raw" ||
        block.kind === "metadata",
    );
}

export function displayRole(ev: ActivityEvent): DisplayRole {
  if (ev.type === "system") return "system";
  if (ev.type === "reasoning") return "reasoning";
  if (ev.type === "assistant") {
    const hasText = ev.blocks.some((block) => block.kind === "text");
    const hasToolUse = ev.blocks.some((block) => block.kind === "tool_use");
    return hasToolUse && !hasText ? "tool" : "assistant";
  }
  const hasToolResult = ev.blocks.some((block) => block.kind === "tool_result");
  const hasText = ev.blocks.some((block) => block.kind === "text");
  return hasToolResult && !hasText ? "result" : "user";
}

/**
 * Tools whose call is itself the thing worth seeing, so it never folds into a run.
 *
 * A skill activation or a delegation changes what the agent is doing; a Read does
 * not. Folding those into "7 tools" hides the one line that explains the next
 * twenty.
 */
const NEVER_CLUSTERED_TOOLS = new Set(["Skill", "Agent"]);

/**
 * Whether this event activates a skill or delegates, and so resists clustering.
 *
 * Claude names the tool. Codex activates a skill by READING its SKILL.md through a
 * shell call, so the signal there is the path in the command -- and 3,123 of the
 * 3,322 such calls across this project's rollouts (94%) name it inside the 200
 * characters the sidecar's summary keeps, which is why this works from the summary
 * the phone also receives rather than needing the untruncated input.
 *
 * The 6% it misses fold into a cluster, which loses a row's prominence, not data.
 */
export function isSkillActivation(ev: ActivityEvent): boolean {
  return ev.blocks.some(
    (block) =>
      block.kind === "tool_use" &&
      ((block.tool !== undefined && NEVER_CLUSTERED_TOOLS.has(block.tool)) ||
        (block.summary ?? "").includes("SKILL.md")),
  );
}

/** A run shorter than this stays as individual rows: folding one row saves nothing. */
const MIN_CLUSTER_EVENTS = 2;

function isClusterable(ev: ActivityEvent): boolean {
  const role = displayRole(ev);
  return (role === "tool" || role === "result") && !isSkillActivation(ev);
}

/** How a folded run describes itself: `7 tools · Bash x4, Edit x2, Read`. */
export function clusterLabel(events: ActivityEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    for (const block of event.blocks) {
      if (block.kind !== "tool_use") continue;
      const tool = block.tool?.trim();
      if (!tool) continue;
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
  }
  const named = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([tool, count]) => (count > 1 ? `${tool} ×${count}` : tool));
  const head = `${events.length} ${events.length === 1 ? "step" : "steps"}`;
  return named.length > 0 ? `${head} · ${named.join(", ")}` : head;
}

export interface DisplayItemOptions {
  /** Fold runs of tool work. False in the raw view, which stays one row per line. */
  cluster?: boolean;
  /** Omit transcript scaffolding from the content-only Nice projection. */
  hideSystem?: boolean;
  /** Show only what each cumulative Codex reasoning snapshot added. */
  incrementalReasoning?: boolean;
  /**
   * Lead event indices of runs the viewer folded. A run is open, one row per call, until it is
   * folded: the calls are what a reader of a live session is watching, and a line saying
   * `Bash ×3` hid exactly that.
   */
  foldedClusters?: ReadonlySet<number>;
}

export function buildActivityDisplayItems(
  events: ActivityEvent[],
  options: DisplayItemOptions = {},
): { items: DisplayItem[]; runLeads: number[] } {
  const items: DisplayItem[] = [];
  // Every clusterable run's lead, open or folded. An open run leaves no cluster row to find it
  // by, and fold-all has to reach it anyway.
  const runLeads: number[] = [];
  let segmentEvents: ActivityEvent[] = [];

  const flush = () => {
    const emitted: DisplayItem[] = [];
    for (let index = 0; index < segmentEvents.length; ) {
      const event = segmentEvents[index]!;
      if (options.cluster && isClusterable(event)) {
        let end = index + 1;
        while (end < segmentEvents.length && isClusterable(segmentEvents[end]!)) end++;
        const run = segmentEvents.slice(index, end);
        if (run.length >= MIN_CLUSTER_EVENTS) {
          runLeads.push(run[0]!.index);
          // The cursor advances past the WHOLE run either way. Advancing by one and
          // letting the loop re-examine the rest re-clustered an open run's tail,
          // because only its first event's index is the one the run is keyed by.
          if (options.foldedClusters?.has(run[0]!.index)) {
            emitted.push({ kind: "cluster", events: run });
          } else {
            for (const member of run) {
              emitted.push({ kind: "segment_event", ev: member, isFirst: false, isLast: false });
            }
          }
          index = end;
          continue;
        }
      }
      emitted.push({ kind: "segment_event", ev: event, isFirst: false, isLast: false });
      index += 1;
    }
    // isFirst/isLast mark the segment's visual ends, so they are positions among the
    // rows actually emitted -- a cluster at either end takes the border.
    for (let index = 0; index < emitted.length; index++) {
      const item = emitted[index]!;
      if (item.kind !== "segment_event") continue;
      item.isFirst = index === 0;
      item.isLast = index === emitted.length - 1;
    }
    items.push(...emitted);
    segmentEvents = [];
  };

  for (const event of events) {
    if (isCompactionEvent(event)) {
      flush();
      items.push({ kind: "compaction", ev: event });
      continue;
    }
    const role = displayRole(event);
    if (role === "user") {
      flush();
      items.push({ kind: "user", ev: event });
    } else if (role === "system") {
      flush();
      items.push({ kind: "segment_event", ev: event, isFirst: true, isLast: true });
    } else {
      segmentEvents.push(event);
    }
  }
  flush();
  return { items, runLeads };
}
