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

import type { TmuxComposerState } from "@agentdesk/agent-feed-wire";
import {
  acceptTmuxComposerHint,
  MAXIMUM_COMPOSER_BYTES,
  liveTmuxComposerRuntime,
  observeTmuxComposer,
  submitTmuxComposer,
  syncTmuxComposer,
  type TmuxComposerListener,
  type TmuxComposerWatchRuntime,
} from "../input/tmuxComposer.ts";
import { encodeServerSentEvent, jsonResponse, startServerSentEventStream } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

const RETRY = new TextEncoder().encode("retry: 20000\n\n");

const COMPOSER_ROUTE =
  /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/composer(\/submit|\/accept|\/stream)?$/i;

/** The composer, injected, so the route's address shape can be pinned without a tmux server. */
export interface TmuxComposerDependencies {
  observe: (sessionId: string, listener: TmuxComposerListener) => () => void;
  sync: (sessionId: string, text: string) => Promise<TmuxComposerState>;
  submit: (sessionId: string) => Promise<TmuxComposerState>;
  /** Presses Tab, which is how Claude's own suggestion becomes text in its box. */
  accept: (sessionId: string) => Promise<TmuxComposerState>;
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

async function sync(
  composer: TmuxComposerDependencies,
  request: Request,
  sessionId: string,
): Promise<Response> {
  let body: { text?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }
  // An empty string is a legitimate ask -- it is what clearing the field means -- so this checks
  // the type and not the length. That is the one place this route differs from the inbox next
  // door, which refuses a blank turn because delivering one would cost a model call.
  if (typeof body.text !== "string") return jsonResponse({ error: "text is required" }, 400);
  if (Buffer.byteLength(body.text, "utf8") > MAXIMUM_COMPOSER_BYTES) {
    return jsonResponse({ error: "text is too large" }, 413);
  }
  // 200 with the reason in the body, for the same reason the inbox does it: "that session is not
  // in a pane" is a fact the panel renders beside the field, not a malformed request.
  return jsonResponse(await composer.sync(sessionId, body.text));
}
