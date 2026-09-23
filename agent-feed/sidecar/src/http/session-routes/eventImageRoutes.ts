// `GET /api/sessions/claude/<id>/events/<n>/blocks/<b>/image?mode=` -- the bytes behind one image
// block, as the image itself. And `.../blocks/<b>/files/<k>?mode=`, which is the same question
// asked of a file a call HANDED to the reader rather than one pasted into the transcript.
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

import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { COMPOSER_IMAGE_MEDIA_TYPES } from "@agentdesk/agent-feed-wire";
import { imageMediaType } from "@/input/composerImages";
import {
  acquireIndex,
  RawEventTooLargeError,
  readEventRaw,
  releaseIndex,
} from "@/transcripts/event-index/eventIndex";
import { toolFilePaths } from "@/transcripts/claude/claudeFiles";
import { findSession } from "@/transcripts/catalog/transcriptCatalog";
import { adapterFor } from "@/transcripts/sourceAdapters";
import { jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";

const EVENT_IMAGE_ROUTE =
  /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/events\/(\d+)\/blocks\/(\d+)\/image$/i;

const EVENT_FILE_ROUTE =
  /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/events\/(\d+)\/blocks\/(\d+)\/files\/(\d+)$/i;

const SERVABLE_MEDIA_TYPES: ReadonlySet<string> = new Set(COMPOSER_IMAGE_MEDIA_TYPES);

/**
 * How large a handed-over file this will read into memory to answer with.
 *
 * Generous, because these are screenshots and renders at retina scale and one of them being
 * refused is the reader not seeing what they were sent. A cap at all is because the path came
 * from a transcript rather than from a size this process chose.
 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

async function eventImage(
  sessionId: string,
  eventIndex: number,
  blockIndex: number,
  mode: "raw" | "nice",
): Promise<Response> {
  const session = findSession("claude", sessionId);
  if (!session || !session.transcriptPath) return jsonResponse({ error: "session not found" }, 404);
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

/**
 * One file a tool call names, by its place in that call's list (`claudeFiles.ts` builds it).
 *
 * The pictures a session makes live on the machine the sidecar runs on rather than in the
 * transcript -- a render `SendUserFile` handed over, a chart a command just wrote -- so a feed
 * without this can only print their names, which is showing the reader the index of something
 * instead of the thing.
 *
 * Addressed by POSITION IN THE TRANSCRIPT, never by a path in the request, and that is the whole
 * access rule: the bytes are served only where this session's own line at this event, this block
 * and this index already names that file. So the capability is the transcript, and the panel
 * cannot ask for anything the session did not name.
 *
 * Two more bounds on top. The content-type is SNIFFED from the bytes with the composer's own
 * reader rather than taken from the extension, so only a real PNG, JPEG, GIF or WebP is ever
 * served and the type always matches what is in the file. And a file larger than the cap answers
 * 413 rather than reading it into memory to hand over.
 */
async function eventFile(
  sessionId: string,
  eventIndex: number,
  blockIndex: number,
  fileIndex: number,
  mode: "raw" | "nice",
): Promise<Response> {
  const session = findSession("claude", sessionId);
  if (!session || !session.transcriptPath) return jsonResponse({ error: "session not found" }, 404);
  acquireIndex("claude", sessionId);
  try {
    const line = await readEventRaw("claude", sessionId, session.transcriptPath, eventIndex, mode);
    if (line === null) return jsonResponse({ error: "event not found" }, 404);
    const block = adapterFor("claude").processLine(line)?.event?.blocks[blockIndex];
    // The same rule the normalizer put on the block, applied to the same line: the panel's `k` is
    // a position in THAT list and nothing else resolves it.
    const path = block?.kind === "tool_use"
      ? toolFilePaths(block.input)[fileIndex]
      : undefined;
    // Absolute only. A relative path would be resolved against whatever directory this process
    // happens to be in, which is not a place the transcript was talking about.
    if (typeof path !== "string" || !isAbsolute(path)) {
      return jsonResponse({ error: "no file at that index" }, 404);
    }
    const info = await stat(path).catch(() => null);
    // A directory, a socket or a device is not a file somebody was sent.
    if (!info?.isFile()) return jsonResponse({ error: "file not found" }, 404);
    if (info.size > MAX_FILE_BYTES) {
      return jsonResponse({ error: "file is too large to show", byteCount: info.size }, 413);
    }
    const bytes = await readFile(path);
    const mediaType = imageMediaType(bytes);
    if (!mediaType) return jsonResponse({ error: "not a picture" }, 415);
    return new Response(bytes, {
      headers: {
        "content-type": mediaType,
        "x-content-type-options": "nosniff",
        // Unlike a transcript line, the file on disk can be rewritten or swept away under a
        // reader who is still scrolling, so this is cached for a while rather than forever.
        "cache-control": "private, max-age=300",
        "last-modified": new Date(info.mtimeMs).toUTCString(),
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
    const image = EVENT_IMAGE_ROUTE.exec(url.pathname);
    const file = image ? null : EVENT_FILE_ROUTE.exec(url.pathname);
    if (!image && !file) return undefined;
    // Rejected rather than defaulted, for the reason the events route gives: an index means a
    // different line in each mode, so a typo answered in raw would serve somebody else's picture.
    const mode = url.searchParams.get("mode") ?? "raw";
    if (mode !== "raw" && mode !== "nice") return jsonResponse({ error: "invalid mode" }, 400);
    if (image) {
      return eventImage(image[1]!.toLowerCase(), Number(image[2]!), Number(image[3]!), mode);
    }
    return eventFile(
      file![1]!.toLowerCase(),
      Number(file![2]!),
      Number(file![3]!),
      Number(file![4]!),
      mode,
    );
  };
}
