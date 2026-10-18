// `GET /api/sessions/claude/<id>/events/<n>/blocks/<b>/image` -- the bytes behind one image
// block, as the image itself. And `.../blocks/<b>/files/<k>`, which is the same question
// asked of a file a call HANDED to the reader rather than one pasted into the transcript.
//
// The opencode sibling below answers the same question for live opencode rows, whose pictures
// arrive inline on the serve's messages rather than in a transcript file: the bytes wait in the
// session pool's image store instead of on disk.
//
// The second one answers for any kind of file, not only a picture, because a reader who was sent
// a page or a report was sent something to OPEN. That address is what the feed's row links to.
//
// An image block on the wire carries its media type and nothing else, so the page an event rides
// in stays small whatever was pasted into it. This is where the picture comes from instead, read
// back out of the transcript line on demand: an `<img>` asks for it only when the row is on screen.
//
// Claude only, in the pattern: Codex writes its images as data URLs its adapter does not turn into
// image blocks, so a Codex path here would be a 404 dressed as a route that exists. The opencode
// pattern below is the live-session counterpart, resolved out of the pool rather than a file.
//
// Ordering note, the same one the timeline and task routes carry: registered BEFORE
// `createSessionRoutes`, whose catch-all rejects unknown `/api/sessions/` paths.

import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { COMPOSER_IMAGE_MEDIA_TYPES } from "@agentdesk/agent-feed-wire";
import { imageMediaType } from "@/input/composer/composerImages";
import { isPictureName } from "@/transcripts/claude/claudeFiles";
import { LineTooLargeError } from "@/transcripts/transcript-reads/transcriptLines";
import { readEventRaw } from "@/transcripts/transcript-reads/transcriptPages";
import { toolFilePaths } from "@/transcripts/claude/claudeFiles";
import { findSession } from "@/transcripts/catalog/transcriptCatalog";
import { adapterFor } from "@/transcripts/sourceAdapters";
import { jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const EVENT_IMAGE_ROUTE = /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/events\/(\d+)\/blocks\/(\d+)\/image$/i;

const EVENT_FILE_ROUTE = /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/events\/(\d+)\/blocks\/(\d+)\/files\/(\d+)$/i;

const OPENCODE_IMAGE_ROUTE =
  /^\/api\/sessions\/opencode\/([A-Za-z0-9._:-]{1,128})\/events\/(\d+)\/blocks\/(\d+)\/image$/;

const SERVABLE_MEDIA_TYPES: ReadonlySet<string> = new Set(COMPOSER_IMAGE_MEDIA_TYPES);

/**
 * How large a handed-over file this will read into memory to answer with.
 *
 * Generous, because these are screenshots and renders at retina scale and one of them being
 * refused is the reader not seeing what they were sent. A cap at all is because the path came
 * from a transcript rather than from a size this process chose.
 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** How much of a file is read to decide whether it is text. */
const TEXT_SAMPLE_BYTES = 64 * 1024;

/**
 * The types that carry script, and so cannot be served as this origin.
 *
 * Decided by NAME, which is the one place here an extension is trusted, because nothing in the
 * bytes separates a page from a text file. The sandbox below is what makes being wrong cheap.
 */
const SCRIPTABLE: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * A document in an opaque origin: its own script runs, and it is nobody as far as this origin is
 * concerned, so it cannot read the panel's storage or call `/api` as the reader.
 *
 * Load-bearing rather than belt-and-braces. The panel's origin has NO authentication in front of
 * it -- the tailnet is the boundary -- so a page served same-origin from a file on disk would be
 * handed the whole sidecar API. `allow-same-origin` is the one thing deliberately absent.
 */
const SANDBOX = "sandbox allow-scripts allow-forms allow-popups";

interface Served {
  /** What the response says it is. */
  type: string;
  /** Whether a browser may render it in a tab, or should save it instead. */
  inline: boolean;
  /** Whether it carries script and has to land in an opaque origin. */
  sandboxed: boolean;
}

/**
 * How one handed-over file is served, or null where it must not be served at all.
 *
 * Read off the BYTES wherever the bytes can say, because the name came out of a transcript. A
 * file that promises a picture and holds something else is the refusal: that is how an
 * `id_rsa.png` would otherwise reach a reader's browser as whatever it turns out to be.
 *
 * Anything unrecognised is handed over as a download rather than rendered as a guess.
 */
export function servedAs(path: string, bytes: Buffer): Served | null {
  const picture = imageMediaType(bytes);
  if (picture) return { type: picture, inline: true, sandboxed: false };
  if (isPictureName(path)) return null;
  const extension = extname(path).toLowerCase();
  const scriptable = SCRIPTABLE[extension];
  if (scriptable) return { type: scriptable, inline: true, sandboxed: true };
  if (extension === ".pdf" && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { type: "application/pdf", inline: true, sandboxed: false };
  }
  if (looksLikeText(bytes)) {
    return { type: "text/plain; charset=utf-8", inline: true, sandboxed: false };
  }
  return { type: "application/octet-stream", inline: false, sandboxed: false };
}

function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, TEXT_SAMPLE_BYTES);
  if (sample.includes(0)) return false;
  try {
    // `stream: true` so a sample cut in the middle of a multi-byte character is not read as
    // invalid; `fatal` so bytes that are genuinely not UTF-8 become a download rather than a
    // page of replacement characters.
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch {
    return false;
  }
}

async function eventImage(sessionId: string, eventIndex: number, blockIndex: number): Promise<Response> {
  const session = findSession("claude", sessionId);
  if (!session || !session.transcriptPath) return jsonResponse({ error: "session not found" }, 404);
  try {
    const line = await readEventRaw(session.transcriptPath, eventIndex);
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
        // A transcript is only ever appended to, so a line's position names the same line forever
        // and the browser never needs to ask twice for a row it scrolls past again.
        "cache-control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    if (error instanceof LineTooLargeError) {
      return jsonResponse({ error: error.message, byteCount: error.byteCount }, 413);
    }
    throw error;
  }
}

/**
 * One file a tool call names, by its place in that call's list (`claudeFiles.ts` builds it).
 *
 * The files a session makes live on the machine the sidecar runs on rather than in the
 * transcript -- a render `SendUserFile` handed over, a page it wrote, a chart a command just
 * wrote -- so a feed without this can only print their names, which is showing the reader the
 * index of something instead of the thing.
 *
 * Addressed by POSITION IN THE TRANSCRIPT, never by a path in the request, and that is the whole
 * access rule: the bytes are served only where this session's own line at this event, this block
 * and this index already names that file. So the capability is the transcript, and the panel
 * cannot ask for anything the session did not name.
 *
 * Two more bounds on top. What the response says the file is comes from `servedAs`, which reads
 * the bytes wherever the bytes can say and sandboxes the two types that carry script. And a file
 * larger than the cap answers 413 rather than reading it into memory to hand over.
 */
async function eventFile(
  sessionId: string,
  eventIndex: number,
  blockIndex: number,
  fileIndex: number,
): Promise<Response> {
  const session = findSession("claude", sessionId);
  if (!session || !session.transcriptPath) return jsonResponse({ error: "session not found" }, 404);
  try {
    const line = await readEventRaw(session.transcriptPath, eventIndex);
    if (line === null) return jsonResponse({ error: "event not found" }, 404);
    const block = adapterFor("claude").processLine(line)?.event?.blocks[blockIndex];
    // The same rule the normalizer put on the block, applied to the same line: the panel's `k` is
    // a position in THAT list and nothing else resolves it.
    const path = block?.kind === "tool_use" ? toolFilePaths(block.input)[fileIndex] : undefined;
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
    const served = servedAs(path, bytes);
    if (!served) {
      return jsonResponse({ error: "the bytes are not the picture the name promises" }, 415);
    }
    const headers: Record<string, string> = {
      "content-type": served.type,
      "x-content-type-options": "nosniff",
      // So the tab, and a save from it, carry the name the reader knows the file by rather than
      // the numbered address it was fetched from.
      "content-disposition": `${served.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
      // Unlike a transcript line, the file on disk can be rewritten or swept away under a
      // reader who is still scrolling, so this is cached for a while rather than forever.
      "cache-control": "private, max-age=300",
      "last-modified": new Date(info.mtimeMs).toUTCString(),
    };
    if (served.sandboxed) headers["content-security-policy"] = SANDBOX;
    return new Response(bytes, { headers });
  } catch (error) {
    if (error instanceof LineTooLargeError) {
      return jsonResponse({ error: error.message, byteCount: error.byteCount }, 413);
    }
    throw error;
  }
}

/**
 * The bytes behind one opencode image block, addressed the way the panel addresses it.
 *
 * Resolved out of the session pool's image store rather than a transcript line: opencode rows
 * are live projections, and the picture's bytes arrived inline on the serve's own message. The
 * address is still a position, never a path in the request -- the panel cannot ask for anything
 * the session's own row at this event and block does not name -- and the media type is checked
 * against the same servable list, since it becomes this response's content-type.
 */
async function opencodeImage(
  sessionId: string,
  eventIndex: number,
  blockIndex: number,
  imageFor: (sessionId: string, eventIndex: number, blockIndex: number) => { mediaType: string; data: string } | null,
): Promise<Response> {
  const picture = imageFor(sessionId, eventIndex, blockIndex);
  if (!picture || !SERVABLE_MEDIA_TYPES.has(picture.mediaType)) {
    return jsonResponse({ error: "no image at that block" }, 404);
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(picture.data, "base64");
  } catch {
    return jsonResponse({ error: "no image at that block" }, 404);
  }
  if (bytes.length === 0) return jsonResponse({ error: "no image at that block" }, 404);
  return new Response(bytes, {
    headers: {
      "content-type": picture.mediaType,
      "x-content-type-options": "nosniff",
      // A reaped session takes its pictures with it and a re-sync stores the same bytes under
      // the same address, so this is cached for a while rather than forever.
      "cache-control": "private, max-age=300",
    },
  });
}

export function createEventImageRoutes(
  imageFor?: (sessionId: string, eventIndex: number, blockIndex: number) => { mediaType: string; data: string } | null,
): RouteHandler {
  return (request, url) => {
    if (request.method !== "GET") return undefined;
    if (imageFor) {
      const opencode = OPENCODE_IMAGE_ROUTE.exec(url.pathname);
      if (opencode) {
        return opencodeImage(opencode[1]!, Number(opencode[2]!), Number(opencode[3]!), imageFor);
      }
    }
    const image = EVENT_IMAGE_ROUTE.exec(url.pathname);
    const file = image ? null : EVENT_FILE_ROUTE.exec(url.pathname);
    if (!image && !file) return undefined;
    // No mode: the index is the byte the row's line starts at, the same line in either view, so
    // there is nothing for a mode to change (ADR-0124).
    if (image) {
      return eventImage(image[1]!.toLowerCase(), Number(image[2]!), Number(image[3]!));
    }
    return eventFile(file![1]!.toLowerCase(), Number(file![2]!), Number(file![3]!), Number(file![4]!));
  };
}
