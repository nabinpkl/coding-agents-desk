/**
 * Where a fork is allowed to start, answered as a transcript row the panel can hand straight back.
 *
 * Both reads exist because the surfaces that ask hold no transcript: the ⋮ on a card and a roster
 * row have nothing loaded to count, and which line is a person speaking is a rule with one home in
 * `messageAnchor.ts` rather than something a panel should re-derive. They live together because
 * they are one question asked at two depths -- the last thing you said, and the last thing you
 * said after the context was summarised -- and a third depth would land here rather than back in
 * the route table.
 */
import { findSession } from "@/transcripts/catalog/transcriptCatalog";
import { errorResponse, jsonResponse } from "@/http/httpResponses";
import { lastCompactionMessage, lastHumanMessage } from "@/transcripts/messageAnchor";
import { NotALineStartError } from "@/transcripts/transcript-reads/transcriptLines";

/** `/api/sessions/claude/:id/last-message`, and Claude only for `--fork-session`'s reason. */
export const LAST_MESSAGE_ROUTE = /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/last-message$/i;
/** `/api/sessions/claude/:id/last-compaction`, the same read one compaction further back. */
export const LAST_COMPACTION_ROUTE = /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/last-compaction$/i;

/**
 * The newest message a person wrote in one session.
 *
 * Read by a fork that was asked for from a session rather than from a row -- the ⋮ on a card, where
 * nobody has picked a message and the point is not having to scroll to find one. The panel is not
 * asked to work it out: it is a rule about which transcript lines are people talking, and a card
 * that is closed has no transcript loaded to apply it to.
 */
export async function lastMessageResponse(sessionId: string, url: URL): Promise<Response> {
  const session = findSession("claude", sessionId);
  if (!session || !session.transcriptPath) return errorResponse("session-not-found", "no such session", 404);
  // `?said=1` passes over a message that only ran a slash command, and `?before=` asks for the last
  // one above a position rather than the newest: both are the user bar's (`messageAnchor.ts`).
  const said = url.searchParams.get("said") === "1";
  const rawBefore = url.searchParams.get("before");
  if (rawBefore !== null && !/^\d+$/.test(rawBefore)) {
    return errorResponse("invalid-position", "before must be a position", 400);
  }
  const before = rawBefore === null ? null : Number(rawBefore);
  let message: Awaited<ReturnType<typeof lastHumanMessage>>;
  try {
    message = await lastHumanMessage(sessionId, session.transcriptPath, { said, before });
  } catch (error) {
    if (error instanceof NotALineStartError) return errorResponse("invalid-position", error.message, 400);
    throw error;
  }
  // 404 rather than an empty body. "Nobody has written one" and "here is one that says nothing"
  // are different answers, and a caller that could not tell them apart would open a fork dialog
  // quoting nothing and start a fork anchored to a row that does not exist.
  if (!message) {
    return errorResponse("no-message", "nobody has written a message in this session yet", 404);
  }
  return jsonResponse(message);
}

/**
 * The first message a person wrote after this session's newest compaction.
 *
 * Two 404s rather than one, because they are two different things to tell a reader. A session that
 * has never been compacted has no such point at all; one that has been compacted and not spoken to
 * since is already at that point, so the ordinary fork beside this in the menu does the same job
 * with nothing to go wrong.
 */
export async function lastCompactionResponse(sessionId: string): Promise<Response> {
  const session = findSession("claude", sessionId);
  if (!session || !session.transcriptPath) return errorResponse("session-not-found", "no such session", 404);
  const message = await lastCompactionMessage(sessionId, session.transcriptPath);
  if (!message) {
    return errorResponse(
      "no-compaction-point",
      "this session has nothing said after a compaction to start from",
      404,
    );
  }
  return jsonResponse(message);
}
