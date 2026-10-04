// Turning a compacted session into the one prompt its successor starts from, either way round.
//
// A handover is what the source's own next API call would have carried, delivered all at once:
// the compaction summary plus every turn since the boundary, as prose. It cannot be native
// history in either direction -- opencode's serve exposes no endpoint that inserts assistant
// turns or tool results, and a Claude session is a CLI process whose only inlet is its first
// turn -- so everything arrives as a single user turn and tool outputs ride as quoted text
// rather than structured results. The model gets the facts but resumes nothing; it re-reads
// files itself.
//
// What is source-specific is only how the events are FETCHED. Claude's come off the transcript
// reads below; opencode's come off the serve, in `opencodeHandover.ts`, which calls back into the two
// renderers here so the caps are decided once.
//
// What is capped and what is not is the whole design. Person and model prose is uncapped (a 16KB
// safety ceiling per turn bounds pathology, and says so when hit), because truncating it is what
// loses the thread. Tool inputs and outputs are capped hard at head plus tail with the middle
// cut, because error lines live at the tail and the call shape at the head. Repeated LINES
// inside one tool output collapse, because fifty identical warnings are one fact; distinct tool
// calls never collapse against each other, because ten runs of one test are ten results.
//
// Read through the transcript page reads, never a parse of its own: those are what turn lines into
// rows, and a second reader parsing its own would agree until the day something stopped parsing
// (see `messageAnchor.ts`). Rendering text off those rows is what the feed already does.

import type { ActivityBlock, ActivityEvent } from "@agentdesk/agent-feed-wire";
import { completeEnd, readEventsBetween } from "@/transcripts/transcript-reads/transcriptPages";

/** The request names nothing to hand over. */
export class SessionHandoverError extends Error {}

/** Prose ceiling per turn: a bound on pathology, not a cap on content. */
export const HANDOVER_PROSE_CEILING = 16_384;
/** A tool input or output keeps this many chars total, head plus tail. */
export const HANDOVER_TOOL_CHARS = 300;
const TOOL_HEAD_CHARS = 200;
const TOOL_TAIL_CHARS = 100;
/** Identical adjacent lines collapse at this run length; pairs stay verbatim. */
export const HANDOVER_REPEAT_THRESHOLD = 3;

export interface RenderedHandover {
  summary: string;
  turns: string;
  /** Turns carried, for the prompt's own accounting. */
  turnCount: number;
  /** True when any ceiling or cap rewrote content, so the prompt can say so. */
  lossy: boolean;
}

/**
 * Collapse runs of identical adjacent lines inside one tool output.
 *
 * Line-wise rather than call-wise: fifty identical warnings in one result are one fact, while two
 * runs of one test are two results and must never merge. Pairs stay verbatim because a pair often
 * carries meaning -- a retry, a before and after -- where a run of three or more is noise.
 */
export function collapseRepeatedLines(text: string, threshold = HANDOVER_REPEAT_THRESHOLD): { text: string; collapsed: boolean } {
  const lines = text.split("\n");
  const out: string[] = [];
  let collapsed = false;
  let run = 1;
  for (let i = 1; i <= lines.length; i += 1) {
    if (i < lines.length && lines[i] === lines[i - 1]) {
      run += 1;
      continue;
    }
    if (run >= threshold) {
      out.push(`${lines[i - 1]} (×${run})`);
      collapsed = true;
    } else {
      for (let k = 0; k < run; k += 1) out.push(lines[i - 1]!);
    }
    run = 1;
  }
  return { text: out.join("\n"), collapsed };
}

/** Keep the head and the tail, cut the middle: the call shape leads, the error trails. */
export function capHeadTail(text: string, head = TOOL_HEAD_CHARS, tail = TOOL_TAIL_CHARS): { text: string; capped: boolean } {
  if (text.length <= head + tail) return { text, capped: false };
  return { text: `${text.slice(0, head)}\n... [middle cut, ${text.length - head - tail} chars] ...\n${text.slice(text.length - tail)}`, capped: true };
}

function renderToolText(raw: string): { text: string; lossy: boolean } {
  const collapsed = collapseRepeatedLines(raw);
  const capped = capHeadTail(collapsed.text);
  return { text: capped.text, lossy: collapsed.collapsed || capped.capped };
}

function renderBlock(block: ActivityBlock): { text: string; lossy: boolean } | null {
  switch (block.kind) {
    case "text":
    case "plain":
    case "raw": {
      const text = block.text ?? "";
      if (!text.trim()) return null;
      if (text.length <= HANDOVER_PROSE_CEILING) return { text, lossy: false };
      return {
        text: `${text.slice(0, HANDOVER_PROSE_CEILING)}\n... [turn cut at ${HANDOVER_PROSE_CEILING} chars] ...`,
        lossy: true,
      };
    }
    case "tool_use": {
      const input = block.input && Object.keys(block.input).length > 0
        ? JSON.stringify(block.input)
        : "";
      const rendered = input ? renderToolText(input) : null;
      const summary = block.summary && block.summary !== input ? ` ${block.summary}` : "";
      return {
        text: `[tool: ${block.tool ?? "unknown"}${summary}]${rendered ? `\n${rendered.text}` : ""}`,
        lossy: rendered?.lossy ?? false,
      };
    }
    case "tool_result": {
      const preview = block.preview ?? block.text ?? "";
      if (!preview.trim()) return { text: "[tool result: (no output)]", lossy: false };
      const rendered = renderToolText(preview);
      return { text: `[tool result:\n${rendered.text}\n]`, lossy: rendered.lossy };
    }
    case "image":
      return { text: `[image omitted: ${block.label ?? "an image"} is not carried by a handover]`, lossy: true };
    case "reasoning":
    case "metadata":
    case "compaction":
    default:
      return null;
  }
}

function renderEvent(event: ActivityEvent): { text: string; lossy: boolean } | null {
  if (event.type !== "user" && event.type !== "assistant") return null;
  const parts: string[] = [];
  let lossy = false;
  for (const block of event.blocks) {
    const rendered = renderBlock(block);
    if (!rendered) continue;
    parts.push(rendered.text);
    lossy = lossy || rendered.lossy;
  }
  const text = parts.join("\n").trim();
  if (!text) return null;
  return { text: `${event.type === "user" ? "human" : "assistant"}: ${text}`, lossy };
}

/**
 * Where the newest compaction sits in a session's events, and the summary it carried.
 *
 * The NEWEST rather than the first: a long session compacts more than once, and the context the
 * reader is looking at is the one the last compaction produced. Null when there was none, which
 * is a refusal rather than a degraded handover -- without a summary this is a long paste with no
 * statement of what the reader is looking at.
 */
export function findCompactionBoundary(
  events: readonly ActivityEvent[],
): { index: number; summary: string } | null {
  let index = -1;
  let summary = "";
  for (let i = 0; i < events.length; i += 1) {
    for (const block of events[i]!.blocks) {
      if (block.kind !== "compaction") continue;
      index = i;
      if (block.text?.trim()) summary = block.text;
    }
  }
  if (index < 0 || !summary.trim()) return null;
  return { index, summary };
}

/**
 * Every person and model turn after `fromIndex`, as the prose the next session reads.
 *
 * Takes events rather than a session, and that is what lets the two directions share it. Claude's
 * come off the transcript reads and opencode's off a projection the serve's messages were mapped into,
 * but by the time they reach here both are `ActivityEvent`, so the caps, the line collapse and the
 * turn separator are decided once instead of drifting per source.
 */
export function renderHandoverTurns(
  events: readonly ActivityEvent[],
  fromIndex: number,
): { turns: string; turnCount: number; lossy: boolean } {
  const turns: string[] = [];
  let lossy = false;
  for (let i = fromIndex + 1; i < events.length; i += 1) {
    const rendered = renderEvent(events[i]!);
    if (!rendered) continue;
    turns.push(rendered.text);
    lossy = lossy || rendered.lossy;
  }
  return { turns: turns.join("\n\n---\n\n"), turnCount: turns.length, lossy };
}

/**
 * The summary and the turns since the newest compaction of a CLAUDE session.
 *
 * Read through the same page reads the panel is served from, so the rows rendered here are parsed
 * by the one rule that made them. That is also why this is Claude's alone -- the reads take a
 * `TranscriptSourceId`, which opencode is explicitly not, because opencode has no file to read.
 * It goes through `renderOpencodeHandover` instead.
 */
export async function renderHandover(sessionId: string, transcriptPath: string): Promise<RenderedHandover> {
  // The whole conversation, because what is handed over is everything since the NEWEST
  // compaction and the boundary is found by reading all of them.
  const end = await completeEnd(transcriptPath);
  const events = await readEventsBetween("claude", sessionId, transcriptPath, 0, end, "raw", null);
  const boundary = findCompactionBoundary(events);
  if (!boundary) {
    throw new SessionHandoverError(`session "${sessionId}" was never compacted: nothing to hand over`);
  }
  return { summary: boundary.summary, ...renderHandoverTurns(events, boundary.index) };
}

/**
 * The one prompt the new session receives: provenance first, handover second, the reader's own
 * message last, where an instruction at the end gets the model's attention rather than buried
 * under sixty kilobytes of history.
 */
export function buildHandoverPrompt(options: {
  source: string;
  sessionId: string;
  handover: RenderedHandover;
  message?: string;
}): string {
  const { source, sessionId, handover, message } = options;
  const lossyNote = handover.lossy
    ? "\n(Note: long tool outputs were collapsed and capped, and images were not carried.)"
    : "";
  const tail = message?.trim() ? `\n\n=== MESSAGE FROM THE READER ===\n${message.trim()}\n` : "";
  return (
    `This was obtained from an earlier session from another agent (${source}, session ${sessionId}). ` +
    `Continue that work.${lossyNote}\n\n` +
    `=== COMPACTION SUMMARY ===\n${handover.summary}\n\n` +
    `=== TURNS SINCE COMPACTION (${handover.turnCount}) ===\n${handover.turns}\n\n` +
    `=== END OF HANDOVER ===${tail}`
  );
}
