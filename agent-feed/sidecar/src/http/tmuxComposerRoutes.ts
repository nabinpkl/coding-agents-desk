// Mirroring the panel's composer into the prompt box of a Claude CLI running in a tmux pane.
//
// Sits beside `cliInputRoutes.ts` and addresses sessions the same way, because it is the same act
// seen from the other end: that one hands the harness a finished turn, this one drives the
// keyboard of the terminal a person is looking at. Claude-only for the same structural reason, and
// refused by the route pattern rather than by a runtime check.
//
// The pane is never named by the caller. It is always derived from the session id -- a request
// that could name a tmux session would be a way to type into any pane on the machine -- and the
// derivation is shared rather than repeated: a live stream publishes the pane it is watching, and
// a push takes it from there instead of reading every session record on disk again.
//
// Reading is a STREAM rather than a request, and there is no request form of it. The composer
// changes when somebody types, which is an event the pane already publishes; asking on a timer
// instead meant a `capture-pane` every second for the whole time a session was open, nearly all
// of them answering "the same as last time". The stream reports only differences.

import {
  MAXIMUM_COMPOSER_IMAGE_BYTES,
  type ComposerImageMediaType,
  type RailKey,
  type RailModifier,
  type RailModifiers,
  type TmuxComposerState,
} from "@agentdesk/agent-feed-wire";
import { imageMediaType, writeComposerImage } from "../input/composer/composerImages.ts";
import { acceptTmuxComposerHint, dropTmuxComposerImage, pressTmuxComposerKey, submitTmuxComposer, syncTmuxComposer } from "../input/composer/composerDrive.ts";
import { MAXIMUM_COMPOSER_BYTES } from "../input/composer/composerKeys.ts";
import { liveTmuxComposerRuntime, type TmuxComposerWatchRuntime } from "../input/composer/composerRuntime.ts";
import { observeTmuxComposer, type TmuxComposerListener } from "../input/composer/composerWatch.ts";
import {
  encodeServerSentEvent,
  errorResponse,
  jsonResponse,
  startServerSentEventStream,
} from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

const RETRY = new TextEncoder().encode("retry: 20000\n\n");

/**
 * The keys the rail can send, spelled out rather than derived from the type.
 *
 * `RailKey` is erased at run time, so something has to hold the set at run time too. Written here
 * next to the route that checks it, and kept in step by the test that asserts every member maps to
 * bytes.
 */
const RAIL_KEYS = new Set<string>(
  ["escape", "tab", "up", "down", "left", "right"] satisfies RailKey[],
);

/** Whether what arrived names a rail key, and narrows it to one when it does. */
function isRailKey(value: unknown): value is RailKey {
  return typeof value === "string" && RAIL_KEYS.has(value);
}

const COMPOSER_ROUTE =
  /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/composer(\/submit|\/accept|\/image|\/key|\/stream)?$/i;

/** The composer, injected, so the route's address shape can be pinned without a tmux server. */
export interface TmuxComposerDependencies {
  observe: (sessionId: string, listener: TmuxComposerListener) => () => void;
  sync: (sessionId: string, text: string) => Promise<TmuxComposerState>;
  submit: (sessionId: string) => Promise<TmuxComposerState>;
  /** Presses Tab, which is how Claude's own suggestion becomes text in its box. */
  accept: (sessionId: string) => Promise<TmuxComposerState>;
  /**
   * Puts an image in the composer, having first written it where that pane's Claude can read it.
   *
   * Bytes rather than a path, in both directions. The panel is not on the machine the pane is on
   * -- it may not even be on a Mac -- so a path it chose would name nothing, and a path it was
   * handed would be a filesystem it has no business knowing.
   */
  drop: (
    sessionId: string,
    image: Uint8Array,
    mediaType: ComposerImageMediaType,
  ) => Promise<TmuxComposerState>;
  /**
   * Presses one key rail key, for a phone whose keyboard does not have it.
   *
   * Named rather than sent as bytes: this is not a second way to write anything into a pane, and
   * the mapping from key to escape sequence has one home on the wire.
   */
  key: (
    sessionId: string,
    key: RailKey,
    held: RailModifiers,
  ) => Promise<TmuxComposerState>;
}

/**
 * The live dependencies, given the pane signal.
 *
 * `watch` is a parameter rather than a default because only the terminal service can supply it:
 * a pane has one pipe and that service owns it, so this module setting its own would replace the
 * terminal viewer's rather than joining it.
 */
export function liveTmuxComposerDependencies(
  watch: TmuxComposerWatchRuntime["watch"],
): TmuxComposerDependencies {
  const runtime = liveTmuxComposerRuntime(watch);
  return {
    observe: (sessionId, listener) => observeTmuxComposer(sessionId, listener, runtime),
    sync: (sessionId, text) => syncTmuxComposer(sessionId, text, runtime),
    submit: (sessionId) => submitTmuxComposer(sessionId, runtime),
    accept: (sessionId) => acceptTmuxComposerHint(sessionId, runtime),
    drop: async (sessionId, image, mediaType) =>
      dropTmuxComposerImage(sessionId, await writeComposerImage(image, mediaType), runtime),
    key: (sessionId, key, held) => pressTmuxComposerKey(sessionId, key, held, runtime),
  };
}

export function createTmuxComposerRoutes(composer: TmuxComposerDependencies): RouteHandler {
  return (request, url, server) => {
    const match = COMPOSER_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    const sessionId = match[1]!.toLowerCase();
    const action = match[2];
    if (action === "/submit" || action === "/accept") {
      if (request.method !== "POST") return undefined;
      const pressed = action === "/submit" ? composer.submit : composer.accept;
      return pressed(sessionId).then((state) => jsonResponse(state));
    }
    if (action === "/image") {
      if (request.method !== "POST") return undefined;
      return drop(composer, request, sessionId);
    }
    if (action === "/key") {
      if (request.method !== "POST") return undefined;
      return pressKey(composer, request, sessionId);
    }
    if (action === "/stream") {
      if (request.method !== "GET") return undefined;
      return startServerSentEventStream(request, server, (write, close) => {
        // How long a client waits before asking again after this stream ends, which is the whole
        // retry mechanism: a session with no pane is answered and hung up on, and `EventSource`
        // comes back by itself. Long enough that a Claude session running outside tmux is a few
        // requests a minute, short enough that pressing the band's own terminal button -- which
        // resumes one -- is noticed while the reader is still looking at it.
        write(RETRY);
        return composer.observe(sessionId, {
          onState: (state) => write(encodeServerSentEvent(state)),
          onEnd: close,
        });
      });
    }
    if (request.method === "POST") return sync(composer, request, sessionId);
    return undefined;
  };
}

/**
 * Presses one key rail key into the session's prompt box.
 *
 * The key is checked against the set the rail can actually produce rather than passed through. It
 * names a byte sequence that goes straight into somebody's pane, so an unrecognised name is a 400
 * and not a best effort: a rail that grows a key the sidecar has not learned should fail where a
 * reader can see it, not send an escape that means something else.
 */
async function pressKey(
  composer: TmuxComposerDependencies,
  request: Request,
  sessionId: string,
): Promise<Response> {
  let body: { key?: unknown; modifiers?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return errorResponse("body-unreadable", "a key press must carry a JSON body", 400);
  }
  if (!isRailKey(body.key)) {
    return errorResponse(
      "key-unknown",
      `a key press must name one of ${[...RAIL_KEYS].join(", ")}`,
      400,
    );
  }
  const held = body.modifiers;
  const modifiers: RailModifiers = {
    // Absent means not held, so a caller that sends only the key gets the unmodified sequence.
    ctrl: heldFlag(held, "ctrl"),
    alt: heldFlag(held, "alt"),
    shift: heldFlag(held, "shift"),
  };
  return jsonResponse(await composer.key(sessionId, body.key, modifiers));
}

/** One modifier out of whatever arrived, true only when it is actually the boolean true. */
function heldFlag(held: unknown, modifier: RailModifier): boolean {
  if (typeof held !== "object" || held === null) return false;
  return (held as Record<string, unknown>)[modifier] === true;
}

async function sync(
  composer: TmuxComposerDependencies,
  request: Request,
  sessionId: string,
): Promise<Response> {
  let body: { text?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return errorResponse("invalid-body", "the request body was not JSON", 400);
  }
  // An empty string is a legitimate ask -- it is what clearing the field means -- so this checks
  // the type and not the length. That is the one place this route differs from the inbox next
  // door, which refuses a blank turn because delivering one would cost a model call.
  if (typeof body.text !== "string") return errorResponse("text-required", "a push must carry the text the composer should hold", 400);
  if (Buffer.byteLength(body.text, "utf8") > MAXIMUM_COMPOSER_BYTES) {
    return errorResponse("text-too-large", "that is more text than a composer will take", 413);
  }
  // 200 with the reason in the body, for the same reason the inbox does it: "that session is not
  // in a pane" is a fact the panel renders beside the field, not a malformed request.
  return jsonResponse(await composer.sync(sessionId, body.text));
}

/**
 * One dropped image: decoded, identified by its own bytes, and pasted into the pane.
 *
 * The kind is sniffed rather than taken from the request, because the file this writes is read
 * back by a program that sniffs for itself. A caller's `content-type` that disagreed with its
 * bytes would produce a name Claude accepts and content it then refuses, and the failure would
 * surface as the file's path appearing in somebody's composer rather than as this 415.
 */
async function drop(
  composer: TmuxComposerDependencies,
  request: Request,
  sessionId: string,
): Promise<Response> {
  let body: { data?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return errorResponse("invalid-body", "the request body was not JSON", 400);
  }
  if (typeof body.data !== "string" || body.data.length === 0) {
    return errorResponse("image-required", "a drop must carry the image as base64", 400);
  }
  // `Buffer.from` does not refuse bad base64, it decodes as far as it can -- so an empty result is
  // the only thing this can say about the encoding, and the sniff below judges the rest.
  const bytes = Uint8Array.from(Buffer.from(body.data, "base64"));
  if (bytes.length === 0) return errorResponse("image-not-base64", "the image did not decode as base64", 400);
  if (bytes.length > MAXIMUM_COMPOSER_IMAGE_BYTES) return errorResponse("image-too-large", "that image is larger than a composer will take", 413);
  const mediaType = imageMediaType(bytes);
  if (mediaType === null) {
    return errorResponse(
      "image-unsupported",
      "a terminal composer takes png, jpeg, gif and webp",
      415,
    );
  }
  return jsonResponse(await composer.drop(sessionId, bytes, mediaType));
}
