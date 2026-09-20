// `GET /api/sessions/claude/<id>/events/<n>/blocks/<b>/image?mode=` -- the bytes behind one image
// block, as the image itself.
//
// An image block on the wire carries its media type and nothing else, so the page an event rides
// in stays small whatever was pasted into it. This is where the picture comes from instead, read
// back out of the transcript line on demand: an `<img>` asks for it only when the row is on screen.
//
// Claude only, in the pattern: Codex writes its images as data URLs its adapter does not turn into
// image blocks, so a Codex path here would be a 404 dressed as a route that exists.
//
// Ordering note, the same one the timeline and task routes carry: registered BEFORE
// `createSessionRoutes`, whose catch-all rejects unknown `/api/sessions/` paths.

import { COMPOSER_IMAGE_MEDIA_TYPES } from "@agentdesk/agent-feed-wire";
import {
  acquireIndex,
  RawEventTooLargeError,
  readEventRaw,
  releaseIndex,
} from "@/transcripts/event-index/eventIndex";
import { findSession } from "@/transcripts/catalog/transcriptCatalog";
import { adapterFor } from "@/transcripts/sourceAdapters";
import { jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";

const EVENT_IMAGE_ROUTE =
  /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/events\/(\d+)\/blocks\/(\d+)\/image$/i;

const SERVABLE_MEDIA_TYPES: ReadonlySet<string> = new Set(COMPOSER_IMAGE_MEDIA_TYPES);

async function eventImage(
  sessionId: string,
  eventIndex: number,
  blockIndex: number,
  mode: "raw" | "nice",
): Promise<Response> {
  const session = findSession("claude", sessionId);
  if (!session) return jsonResponse({ error: "session not found" }, 404);
  acquireIndex("claude", sessionId);
  try {
    const line = await readEventRaw("claude", sessionId, session.transcriptPath, eventIndex, mode);
    if (line === null) return jsonResponse({ error: "event not found" }, 404);
    const adapter = adapterFor("claude");
    const block = adapter.processLine(line)?.event?.blocks[blockIndex];
    // Checked against the same list the normalizer used, rather than trusted from the line: the
    // type becomes this response's content-type, and the page is the panel's own origin.
    if (block?.kind !== "image" || !block.mediaType || !SERVABLE_MEDIA_TYPES.has(block.mediaType)) {
      return jsonResponse({ error: "no image at that block" }, 404);
    }
    const data = await adapter.extractBlockRaw?.(line, blockIndex);
    if (!data) return jsonResponse({ error: "no image at that block" }, 404);
    return new Response(Buffer.from(data, "base64"), {
      headers: {
        "content-type": block.mediaType,
        "x-content-type-options": "nosniff",
        // A transcript is only ever appended to, so an index in a mode names the same line forever
        // and the browser never needs to ask twice for a row it scrolls past again.
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    if (error instanceof RawEventTooLargeError) {
      return jsonResponse({ error: error.message, byteCount: error.byteCount }, 413);
    }
    throw error;
  } finally {
    releaseIndex("claude", sessionId);
  }
}

export function createEventImageRoutes(): RouteHandler {
  return (request, url) => {
    if (request.method !== "GET") return undefined;
    const match = EVENT_IMAGE_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    // Rejected rather than defaulted, for the reason the events route gives: an index means a
    // different line in each mode, so a typo answered in raw would serve somebody else's picture.
    const mode = url.searchParams.get("mode") ?? "raw";
    if (mode !== "raw" && mode !== "nice") return jsonResponse({ error: "invalid mode" }, 400);
    return eventImage(match[1]!.toLowerCase(), Number(match[2]!), Number(match[3]!), mode);
  };
}
