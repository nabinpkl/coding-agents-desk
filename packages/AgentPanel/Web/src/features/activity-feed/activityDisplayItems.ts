import type { ActivityBlock, ActivityEvent } from "./useSessionEventsStream";

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
 * Blocks that render as flowing text rather than a bordered card.
 *
 * Load-bearing for the event heading: the heading floats so the first line of
 * prose sits beside it instead of below it, and a floated box overlaps a
 * following block box (only its LINE boxes are pushed aside). Flow blocks are
 * therefore the ones safe to place next to the float; everything else has to
 * clear it.
 */
export function isFlowBlock(block: ActivityBlock): boolean {
  return block.kind === "text" || block.kind === "reasoning";
}

/**
 * Drop inline Markdown markers from a single line of preview text.
 *
 * A preview is one truncated line, so it is never rendered as Markdown -- which
 * meant a reasoning trace opening with `**Topic**` put its asterisks on screen,
 * the same defect as rendering the body as plain text. Stripping is the right
 * answer rather than rendering: the line is already lossy, and a half-parsed
 * fragment (an unclosed fence, a cut-off link) is worse than plain words.
 */
export function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![*\w])\*(?!\s)([^*]+?)(?<!\s)\*(?!\w)/g, "$1")
    .replace(/`+([^`]+)`+/g, "$1")
    .trim();
}

/**
 * One-line gist of an event, for the collapsed row and the sticky bar.
 *
 * Shared so those two can never disagree about what an event "is" -- they were
 * two independent copies of this scan, which is exactly the drift this repo's
 * one-authoritative-home rule exists to stop.
 */
export function eventPreview(ev: ActivityEvent): string {
  let preview = "";
  for (const block of ev.blocks) {
    if (block.kind === "text" && block.text) { preview = block.text; break; }
    if (block.kind === "tool_use") { preview = block.summary || block.tool || ""; break; }
    if (block.kind === "tool_result" && block.preview) { preview = block.preview; break; }
    if (block.kind === "reasoning" && block.text) { preview = block.text; break; }
    // A metadata or plain block IS the content of a harness state line -- the whole
    // event is one labelled dump. Scanning only the four kinds above made every such
    // row in the raw view read as a chip beside "(no content)", which is exactly the
    // rows the raw view exists to show.
    if ((block.kind === "metadata" || block.kind === "plain") && (block.label || block.text)) {
      preview = block.label && block.text
        ? `${block.label}: ${block.text}`
        : block.label ?? block.text ?? "";
      break;
    }
  }
  return stripInlineMarkdown(preview.split("\n")[0]!).slice(0, 200);
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
  /** Lead event indices of clusters the viewer opened. */
  expandedClusters?: ReadonlySet<number>;
}

export function buildActivityDisplayItems(
  events: ActivityEvent[],
  options: DisplayItemOptions = {},
): DisplayItem[] {
  const items: DisplayItem[] = [];
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
          // The cursor advances past the WHOLE run either way. Advancing by one and
          // letting the loop re-examine the rest re-clustered an expanded run's tail,
          // because only its first event's index is the one the viewer opened.
          if (options.expandedClusters?.has(run[0]!.index)) {
            for (const member of run) {
              emitted.push({ kind: "segment_event", ev: member, isFirst: false, isLast: false });
            }
          } else {
            emitted.push({ kind: "cluster", events: run });
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
  return items;
}

/** A tool_result that renders inside the tool call it answers. */
export interface PairedToolResult {
  block: ActivityBlock;
  eventIndex: number;
  blockIndex: number;
  includesRawEvent: boolean;
  /** The result event's own metadata, which travels into the tool call's
   *  Raw drawer because the event no longer gets a row of its own. */
  metadata: ActivityBlock[];
}

/** Everything the feed needs to render one window of events. */
export interface FeedLayout {
  items: DisplayItem[];
  /** Indices of the single-event rows that own a collapse toggle. */
  allEventIds: number[];
  /** Lead indices of every clusterable run, folded or not, for the fold-all control. */
  clusterLeadIds: number[];
  /** Keyed by callId. */
  pairedToolResults: Map<string, PairedToolResult>;
}

// Pair result-only events with their matching tool calls, so a call and its
// output read as one row. Mixed events stay independent: user prose or an
// unmatched result must never be hidden inside someone else's row.
export function buildFeedLayout(
  events: ActivityEvent[],
  options: DisplayItemOptions = {},
): FeedLayout {
  const toolCallIds = new Set(
    events.flatMap((event) =>
      event.blocks.flatMap((block) =>
        block.kind === "tool_use" && block.callId ? [block.callId] : [],
      ),
    ),
  );
  const pairedToolResults = new Map<string, PairedToolResult>();
  const pairedResultEventIds = new Set<number>();

  for (const event of events) {
    const resultBlocks = event.blocks
      .map((block, blockIndex) => ({ block, blockIndex }))
      .filter(({ block }) => block.kind === "tool_result");
    // Metadata does not make an event more than its result: the adapters
    // append Working Directory to nearly every Claude line, and excluding it
    // here left every Claude result stranded in its own row instead of nesting
    // under the call that produced it. Same trap as isCompactionEvent.
    const isResultOnly = event.blocks.every(
      (block) =>
        block.kind === "tool_result" ||
        block.kind === "raw" ||
        block.kind === "metadata",
    );
    const canPairEveryResult = resultBlocks.every(
      ({ block }) => block.callId && toolCallIds.has(block.callId),
    );
    if (!isResultOnly || resultBlocks.length === 0 || !canPairEveryResult) continue;

    pairedResultEventIds.add(event.index);
    const { folded, hasRawJson } = partitionEventBlocks(event);
    resultBlocks.forEach(({ block, blockIndex }, resultIndex) => {
      // Only the first result of an event carries the event-level raw line and
      // metadata; the rest would just repeat them.
      const isFirst = resultIndex === 0;
      pairedToolResults.set(block.callId!, {
        block,
        eventIndex: event.index,
        blockIndex,
        includesRawEvent: hasRawJson && isFirst,
        metadata: isFirst ? folded : [],
      });
    });
  }

  const displayEvents = events.filter(
    (event) => !pairedResultEventIds.has(event.index),
  );
  const items = buildActivityDisplayItems(displayEvents, options);
  // Derived from the items rather than the events, so a member of a folded cluster
  // does not appear to own a collapse toggle it has no row to carry. Cluster leads
  // are listed separately because their toggle means the opposite thing: membership
  // in `expandedClusters` OPENS a cluster, where membership in `collapsed` closes a
  // row, and one set cannot express both defaults.
  const allEventIds: number[] = [];
  const clusterLeadIds: number[] = [];
  for (const item of items) {
    if (item.kind === "cluster") clusterLeadIds.push(item.events[0]!.index);
    else allEventIds.push(item.ev.index);
  }
  // An OPEN cluster contributes its lead too, or the fold-all control could not
  // close what the viewer just opened.
  for (const lead of options.expandedClusters ?? []) {
    if (allEventIds.includes(lead)) clusterLeadIds.push(lead);
  }
  return { items, allEventIds, clusterLeadIds, pairedToolResults };
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
/**
 * The agent's own words for what an event's tool calls were for, or null when none said.
 *
 * This rides the event's role heading rather than replacing anything on the tool row, because the
 * two answer different questions and both are wanted at a glance: the row says WHAT ran (a
 * truncated command, precise and copyable in full one click away), the heading says WHY. Putting
 * the description on the row meant reading the intent and losing the command, or the reverse.
 *
 * The heading line is otherwise empty on an expanded tool event -- the chip, then nothing -- so
 * this costs no vertical space at all.
 *
 * First description wins. An event with parallel tool calls has several, and a heading is one
 * line; the rest are still on their own rows.
 */
export function toolIntent(event: { blocks: ActivityBlock[] }): string | null {
  for (const block of event.blocks) {
    if (block.kind !== "tool_use") continue;
    const description = block.input?.description;
    if (typeof description === "string" && description.trim()) return description.trim();
  }
  return null;
}

export function shellCommand(block: ActivityBlock): string | null {
  const inputKey = block.tool ? SHELL_COMMAND_INPUT.get(block.tool) : undefined;
  if (inputKey === undefined) return null;
  const fromInput = block.input?.[inputKey];
  if (typeof fromInput === "string" && fromInput.trim()) return fromInput;
  return block.summary?.trim() ? block.summary : null;
}
