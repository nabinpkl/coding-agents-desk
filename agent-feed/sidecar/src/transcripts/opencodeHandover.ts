// Reading an opencode session's handover off the serve, since it has no transcript to index.
//
// The Claude direction opens a file; this one makes HTTP calls. That is ADR-0116 showing through:
// opencode sessions are registered and reconciled off the serve's own list, never discovered on
// disk, so there is no path to hand the transcript reads and no file whose bytes are the record.
//
// Two decisions are worth not rediscovering.
//
// The events come from the ordinary mapper, through a throwaway projection. Re-deriving turns
// from raw `SessionMessage`s here would be a second reader of opencode's message shape, and the
// two would agree until the serve changed something -- which is the drift the one-authoritative-
// home rule exists to stop. A projection with no listeners is just an ordered map, so building
// one costs nothing and the feed's own translation is what the handover carries.
//
// The SUMMARY, though, is read from the raw message rather than from that projection. The mapper
// caps text at 8000 chars for the feed, which is right for a row nobody has to act on and wrong
// here: ADR-0119 leaves the summary uncapped on purpose, because it is the one part of a handover
// that states what the reader is looking at. Measured on this project's own transcripts, a real
// summary runs 16KB to 28KB, so the feed's cap would silently cut a third to two thirds of it.

import type { SessionMessageInfo as SessionMessage } from "@opencode/client";
import { LiveAgentProjection } from "@/agents/liveAgentProjection";
import { OpencodeEventMapper } from "@/agents/opencode/opencodeEventMapper";
import { readOpencodeHistory } from "@/agents/opencode/opencodeHistory";
import {
  findCompactionBoundary,
  renderHandoverTurns,
  SessionHandoverError,
  type RenderedHandover,
} from "@/transcripts/sessionHandover";

/** The serve's own ordering key, which the mapper sorts by and this file has to agree with. */
function messageTime(message: SessionMessage): number {
  const created = (message as { time?: { created?: unknown } }).time?.created;
  return typeof created === "number" ? created : 0;
}

/**
 * The summary and the turns since the newest landed compaction of an OPENCODE session.
 *
 * "Landed" is not a detail. The serve inserts a compaction checkpoint when compaction STARTS and
 * flips it to `completed` when it lands, and a retry compacts the same session under a new
 * message; the mapper draws a row only for the ones that landed. A handover cut at a running or
 * aborted compaction would carry a summary still being written, or one that was thrown away.
 *
 * Which compaction to cut at is decided ONCE, in the events, and the raw summary is then found by
 * that row's own id. Asking the messages separately would be two answers to one question, and
 * they diverge exactly when it matters: the mapper drops rows, so an index into the messages is
 * not an index into the events, and a retry puts two candidates in the list.
 *
 * Throws `SessionHandoverError` when there is no landed compaction, the same refusal the Claude
 * direction makes for the same reason.
 */
export async function renderOpencodeHandover(
  sessionId: string,
  readHistory: typeof readOpencodeHistory = readOpencodeHistory,
): Promise<RenderedHandover> {
  const messages = [...await readHistory(sessionId)].sort((a, b) => messageTime(a) - messageTime(b));
  const projection = new LiveAgentProjection();
  new OpencodeEventMapper(projection).sync(messages);
  const events = projection.page(0, projection.total);

  const boundary = findCompactionBoundary(events);
  if (!boundary) {
    throw new SessionHandoverError(`session "${sessionId}" was never compacted: nothing to hand over`);
  }
  const messageId = events[boundary.index]!.id.replace(/^opencode:/, "");
  const compaction = messages.find((message) => message.id === messageId);
  const summary = (compaction as { summary?: unknown } | undefined)?.summary;
  if (typeof summary !== "string" || !summary.trim()) {
    // The row exists, so the projection had text for it; what is missing is the UNCAPPED text,
    // and handing over the capped copy silently would be the one failure this file exists to
    // prevent. Refused out loud instead.
    throw new SessionHandoverError(`session "${sessionId}" has a compaction row with no readable summary`);
  }
  return { summary, ...renderHandoverTurns(events, boundary.index) };
}
