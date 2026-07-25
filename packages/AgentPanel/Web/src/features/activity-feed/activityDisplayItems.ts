import type { ActivityBlock, ActivityEvent } from "./useSessionEventsStream";

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

/** How one event's blocks split between its visible body and its Raw drawer. */
export interface EventBlockLayout {
  /** Rendered in the event body, carrying each block's original index. */
  inline: { block: ActivityBlock; index: number }[];
  /** Metadata moved into the collapsed Raw drawer. */
  folded: ActivityBlock[];
  /** The event carries a raw block, so Raw JSON nests inside that drawer. */
  hasRawJson: boolean;
}

// Metadata annotates the event's content: token counts, stop reason, and the
// working directory the adapter appends to nearly every Claude line. Three
// bordered cards under every tool call bury the call itself, so metadata folds
// into the Raw drawer alongside the raw line. When metadata is ALL the event
// has (Codex "Agent Message" / "Developer Message" system lines) it is the
// content, and folding it would leave a row with nothing on it.
export function partitionEventBlocks(ev: ActivityEvent): EventBlockLayout {
  const hasContent = ev.blocks.some(
    (block) => block.kind !== "metadata" && block.kind !== "raw",
  );
  const inline: { block: ActivityBlock; index: number }[] = [];
  const folded: ActivityBlock[] = [];
  let hasRawJson = false;

  ev.blocks.forEach((block, index) => {
    if (block.kind === "raw") {
      hasRawJson = true;
      return;
    }
    if (block.kind === "metadata" && hasContent) {
      folded.push(block);
      return;
    }
    inline.push({ block, index });
  });

  return { inline, folded, hasRawJson };
}

// Shell-running tools per source, mapped to the input key holding the command.
// Claude: Bash. Codex: shell / exec_command. A Map, not an object literal:
// tool names come from the transcript, and `SHELL_COMMAND_INPUT["constructor"]`
// on a literal would resolve up the prototype chain to a truthy value.
const SHELL_COMMAND_INPUT = new Map([
  ["Bash", "command"],
  ["shell", "command"],
  ["exec_command", "cmd"],
]);

/**
 * The command a shell tool call ran, or null for any other tool.
 *
 * Prefers the raw `input`, which only the macOS panel sees: the iOS wire
 * ActivityBlock carries no `input`, so the phone falls back to the sidecar's
 * summary (the same command, capped at 200 characters). Codex `shell` can also
 * carry an argv array rather than a string, which takes the same fallback.
 */
export function shellCommand(block: ActivityBlock): string | null {
  const inputKey = block.tool ? SHELL_COMMAND_INPUT.get(block.tool) : undefined;
  if (inputKey === undefined) return null;
  const fromInput = block.input?.[inputKey];
  if (typeof fromInput === "string" && fromInput.trim()) return fromInput;
  return block.summary?.trim() ? block.summary : null;
}
