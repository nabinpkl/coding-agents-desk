import type { ActivityEvent } from "./useSessionEventsStream";

export type DisplayItem =
  | { kind: "user"; ev: ActivityEvent }
  | { kind: "segment_event"; ev: ActivityEvent; isFirst: boolean; isLast: boolean }
  | { kind: "compaction"; ev: ActivityEvent };

export type DisplayRole =
  | "user"
  | "assistant"
  | "tool"
  | "result"
  | "reasoning"
  | "system";

function isCompactionEvent(ev: ActivityEvent): boolean {
  return ev.blocks.some((block) => block.kind === "compaction") &&
    ev.blocks.every((block) => block.kind === "compaction" || block.kind === "raw");
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

export function buildActivityDisplayItems(events: ActivityEvent[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  let segmentEvents: ActivityEvent[] = [];

  const flush = () => {
    for (let index = 0; index < segmentEvents.length; index++) {
      items.push({
        kind: "segment_event",
        ev: segmentEvents[index]!,
        isFirst: index === 0,
        isLast: index === segmentEvents.length - 1,
      });
    }
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
  return items;
}
