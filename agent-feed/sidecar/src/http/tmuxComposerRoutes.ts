// Mirroring the panel's composer into the prompt box of a Claude CLI running in a tmux pane.
//
// Sits beside `cliInputRoutes.ts` and addresses sessions the same way, because it is the same act
// seen from the other end: that one hands the harness a finished turn, this one drives the
// keyboard of the terminal a person is looking at. Claude-only for the same structural reason, and
// refused by the route pattern rather than by a runtime check.
//
// The pane is never named by the caller. It is resolved here, from the session id, every time --
// a request that could name a tmux session would be a way to type into any pane on the machine.
//
// GET never writes, because the panel polls it while somebody is composing.

import type { TmuxComposerState } from "@agentdesk/agent-feed-wire";
import {
  MAXIMUM_COMPOSER_BYTES,
  readTmuxComposer,
  submitTmuxComposer,
  syncTmuxComposer,
} from "../input/tmuxComposer.ts";
import { jsonResponse } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

const COMPOSER_ROUTE = /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/composer(\/submit)?$/i;

/** The composer, injected, so the route's address shape can be pinned without a tmux server. */
export interface TmuxComposerDependencies {
  read: (sessionId: string) => Promise<TmuxComposerState>;
  sync: (sessionId: string, text: string) => Promise<TmuxComposerState>;
  submit: (sessionId: string) => Promise<TmuxComposerState>;
}

const LIVE: TmuxComposerDependencies = {
  read: (sessionId) => readTmuxComposer(sessionId),
  sync: (sessionId, text) => syncTmuxComposer(sessionId, text),
  submit: (sessionId) => submitTmuxComposer(sessionId),
};

export function createTmuxComposerRoutes(
  composer: TmuxComposerDependencies = LIVE,
): RouteHandler {
  return (request, url) => {
    const match = COMPOSER_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    const sessionId = match[1]!.toLowerCase();
    const submitting = match[2] !== undefined;
    if (submitting) {
      if (request.method !== "POST") return undefined;
      return composer.submit(sessionId).then((state) => jsonResponse(state));
    }
    if (request.method === "GET") return composer.read(sessionId).then((state) => jsonResponse(state));
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
