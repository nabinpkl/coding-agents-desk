// `GET /api/tmux/sessions` -- what the terminal grid can attach to -- and
// `DELETE /api/tmux/sessions/:name` -- ending one on purpose -- and
// `POST /api/tmux/sessions/:name/image` -- dropping an image onto one's pane.
//
// Its own route file rather than a corner of the terminal routes: a tmux session is not a terminal
// the sidecar owns, it is a thing on the machine that a terminal can be pointed at, and the two
// have separate lifetimes.
//
// The kill is the deliberate exception to the rule `tmuxAttachment.ts` states above `detach()`:
// a viewer leaving never ends a session, whatever the caller called it. That rule is about a
// viewer -- a closing browser tab must not end work it was only ever watching. This is the
// opposite actor, the owner asking on purpose through an endpoint whose entire subject is ending
// a session, confirmed in the panel before it is sent. Do not merge this path with the viewer's,
// and do not delete it as a violation of a rule it is the exception to.
//
// The image drop is paste-path-as-text, and deliberately NOT the composer drop in
// `tmuxComposerRoutes.ts`: that one addresses a Claude session by transcript id, finds Claude's
// prompt box on its screen, and leans on Claude's own paste handler turning the path into an
// `[Image #N]`. A terminal tile is a bare tmux session running anything -- opencode, a shell --
// with no box to find and no handler to lean on. Measured on a live opencode: a pasted path
// stays text, and the model still reads it through its own `read` tool on the next turn. So
// this writes the bytes where the pane's machine can read them and pastes the absolute path,
// which is also exactly what a Finder drag into a normal terminal does.

import type {
  ComposerImageMediaType,
  TmuxSessionSummary,
} from "@agentdesk/agent-feed-wire";
import { MAXIMUM_COMPOSER_IMAGE_BYTES } from "@agentdesk/agent-feed-wire";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import { imageMediaType, writeComposerImage } from "@/input/composer/composerImages";
import { paste } from "@/input/composer/composerKeystrokes";
import { hexKeyArguments } from "@/terminal/tmux/tmuxAttachment";
import {
  killTmuxSession,
  listTmuxSessions,
  sendTmuxBytes,
  TmuxUnavailable,
} from "@/terminal/tmux/tmuxSessions";

const TMUX_SESSIONS_ROUTE = "/api/tmux/sessions";
const TMUX_SESSION_ROUTE_PATTERN = /^\/api\/tmux\/sessions\/([^/]+)$/;
const TMUX_SESSION_IMAGE_ROUTE_PATTERN = /^\/api\/tmux\/sessions\/([^/]+)\/image$/;

export function createTmuxRoutes(
  list: () => Promise<TmuxSessionSummary[]> = listTmuxSessions,
  kill: (session: string) => Promise<void> = killTmuxSession,
  drop: (
    session: string,
    image: Uint8Array,
    mediaType: ComposerImageMediaType,
  ) => Promise<void> = dropTmuxSessionImage,
): RouteHandler {
  return (request, url) => {
    if (request.method === "GET" && url.pathname === TMUX_SESSIONS_ROUTE) {
      return list()
        .then((sessions) => jsonResponse({ sessions }))
        .catch((error: unknown) => jsonResponse({
          error: {
            code: "tmux-unavailable",
            message: error instanceof TmuxUnavailable ? error.message : String(error),
            // Installing tmux, or starting its server, changes the answer without a restart.
            retryable: true,
          },
        }, 503));
    }
    if (request.method === "POST") {
      const image = TMUX_SESSION_IMAGE_ROUTE_PATTERN.exec(url.pathname);
      if (image) return dropImage(request, image[1]!, drop);
      return undefined;
    }
    if (request.method === "DELETE") {
      const match = TMUX_SESSION_ROUTE_PATTERN.exec(url.pathname);
      if (!match) return undefined;
      const session = safeSessionName(match[1]!);
      if (!session) {
        return jsonResponse({
          error: {
            code: "invalid-tmux-session",
            message: "tmux session name is not a plain identifier",
            retryable: false,
          },
        }, 400);
      }
      return kill(session)
        .then(() => new Response(null, { status: 204 }))
        .catch((error: unknown) => jsonResponse({
          error: {
            code: "tmux-unavailable",
            message: error instanceof TmuxUnavailable ? error.message : String(error),
            retryable: true,
          },
        }, 503));
    }
    return undefined;
  };
}

/**
 * What may be ended through this route, decoded and refused at the door.
 *
 * The name reaches tmux as `-t =<session>` on an argument vector this process builds, so
 * anything but a plain identifier is a 400 rather than something quoted and hoped for. A
 * session that is already gone is not an error: `killTmuxSession` treats it as the ordinary
 * case, because retiring something that has already stopped usually is.
 */
function safeSessionName(raw: string): string | null {
  let session: string;
  try {
    session = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(session)) return null;
  return session;
}

/**
 * The validation half of the image drop, with the same codes as the composer drop it is not.
 *
 * `Buffer.from` does not refuse bad base64, it decodes as far as it can -- so an empty result
 * is the only thing this can say about the encoding, and the sniff below judges the rest. The
 * kind is sniffed rather than taken from the request, because the file this writes is read back
 * by a program that sniffs for itself.
 */
async function dropImage(
  request: Request,
  raw: string,
  drop: (
    session: string,
    image: Uint8Array,
    mediaType: ComposerImageMediaType,
  ) => Promise<void>,
): Promise<Response> {
  const session = safeSessionName(raw);
  if (!session) {
    return jsonResponse({
      error: {
        code: "invalid-tmux-session",
        message: "tmux session name is not a plain identifier",
        retryable: false,
      },
    }, 400);
  }
  let body: { data?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return errorResponse("invalid-body", "the request body was not JSON", 400);
  }
  if (typeof body.data !== "string" || body.data.length === 0) {
    return errorResponse("image-required", "a drop must carry the image as base64", 400);
  }
  const bytes = Uint8Array.from(Buffer.from(body.data, "base64"));
  if (bytes.length === 0) return errorResponse("image-not-base64", "the image did not decode as base64", 400);
  if (bytes.length > MAXIMUM_COMPOSER_IMAGE_BYTES) {
    return errorResponse("image-too-large", "that image is larger than a pane will take", 413);
  }
  const mediaType = imageMediaType(bytes);
  if (mediaType === null) {
    return errorResponse(
      "image-unsupported",
      "a terminal pane takes png, jpeg, gif and webp",
      415,
    );
  }
  return drop(session, bytes, mediaType)
    // No composer state to report: a bare pane has no box, so the answer is the act.
    .then(() => new Response(null, { status: 204 }))
    .catch((error: unknown) => jsonResponse({
      error: {
        code: "tmux-unavailable",
        message: error instanceof TmuxUnavailable ? error.message : String(error),
        retryable: true,
      },
    }, 503));
}

/**
 * Writes the bytes where the pane's machine can read them, then pastes the absolute path.
 *
 * Exactly the path, with no separating space: unlike the composer drop there is no box whose
 * trailing space can be read, and guessing one would type into whatever the reader was writing.
 * The paste is bracketed, so a `/` or command name in it is inserted rather than dispatched.
 */
export async function dropTmuxSessionImage(
  session: string,
  image: Uint8Array,
  mediaType: ComposerImageMediaType,
): Promise<void> {
  const path = await writeComposerImage(image, mediaType);
  await sendTmuxBytes(session, hexKeyArguments(new TextEncoder().encode(paste(path))));
}
