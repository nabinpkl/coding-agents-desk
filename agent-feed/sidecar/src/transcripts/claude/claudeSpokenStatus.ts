// How a Claude session's latest turn stands, said for a listener, followed line by line through its
// transcript (`claudeTaskState.ts` runs this in the same pass as the task block, so the catalog
// reads each new byte once).
//
// - The session's own text closing with a `<spoken-status>` block sets it.
// - A question it asks through `AskUserQuestion` sets it to that question, `waiting`.
// - The answer to that question clears it: the turn goes on, and the question is no longer news.
// - A person starting a new turn clears it: what the last turn ended with is not how this one stands.
//
// Only the main thread counts, as for the task block: a subagent's turn is not the session's.

import { normalizedLine } from "@/transcripts/claude/claudeNormalize";
import { isHumanTurnStart } from "@/transcripts/humanTurns";
import {
  mayHoldSpokenStatus,
  parseSpokenStatus,
  questionStatus,
  type SessionSpokenStatus,
} from "@/transcripts/spokenStatus";

export interface SpokenStatusTrack {
  status: SessionSpokenStatus | null;
  /** The tool call of the question being waited on, whose answer clears it. */
  questionId: string | null;
}

export function emptySpokenStatusTrack(): SpokenStatusTrack {
  return { status: null, questionId: null };
}

const QUESTION_TOOL = "AskUserQuestion";

/**
 * Whether `line` can move the track, tested on the raw text so most lines are never parsed: tool
 * results are most of a transcript, and only the one answering the pending question matters.
 */
function mayMove(line: string, track: SpokenStatusTrack): boolean {
  if (track.questionId !== null && line.includes(track.questionId)) return true;
  if (mayHoldSpokenStatus(line) || line.includes(`"${QUESTION_TOOL}"`)) return true;
  return line.includes('"type":"user"') && !line.includes('"tool_use_id"');
}

type Block = { type?: unknown; text?: unknown; name?: unknown; id?: unknown; input?: unknown; tool_use_id?: unknown };

/** Moves `track` past one transcript line. */
export function followSpokenStatus(line: string, track: SpokenStatusTrack): void {
  if (!mayMove(line, track)) return;
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    record = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (record.isSidechain === true) return;
  const content = (record.message as { content?: unknown } | undefined)?.content;
  const blocks: Block[] = Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Block[]) : [];
  if (record.type === "assistant") {
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    const when = Number.isFinite(at) ? at : 0;
    for (const block of blocks) {
      if (block.type === "tool_use" && block.name === QUESTION_TOOL && typeof block.id === "string") {
        const questions = (block.input as { questions?: { question?: unknown }[] } | undefined)?.questions ?? [];
        const status = questionStatus(
          questions.map((q) => (typeof q?.question === "string" ? q.question : "")),
          when,
        );
        if (status) {
          track.status = status;
          track.questionId = block.id;
        }
      } else if (block.type === "text" && typeof block.text === "string") {
        const status = parseSpokenStatus(block.text, when);
        if (status) {
          track.status = status;
          track.questionId = null;
        }
      }
    }
    return;
  }
  if (record.type !== "user") return;
  const answered =
    track.questionId !== null &&
    blocks.some((block) => block.type === "tool_result" && block.tool_use_id === track.questionId);
  const event = answered ? null : normalizedLine(line)?.result.event;
  if (answered || (event && isHumanTurnStart(event))) {
    track.status = null;
    track.questionId = null;
  }
}
