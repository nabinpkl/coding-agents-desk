// What one event says in a line: the preview a collapsed row shows, the intent the
// agent gave for its tool calls, and the command a shell tool actually ran.

import type { ActivityBlock, ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

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
