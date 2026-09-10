// `GET /api/tmux/sessions` -- what the terminal grid can attach to.
//
// Its own route file rather than a corner of the terminal routes: a tmux session is not a terminal
// the sidecar owns, it is a thing on the machine that a terminal can be pointed at, and the two
// have separate lifetimes.

import type { TmuxSessionSummary } from "@agentdesk/agent-feed-wire";
import { listTmuxSessions, TmuxUnavailable } from "@/terminal/tmux/tmuxSessions";
import { jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";

const TMUX_SESSIONS_ROUTE = "/api/tmux/sessions";

export function createTmuxRoutes(
  list: () => Promise<TmuxSessionSummary[]> = listTmuxSessions,
): RouteHandler {
  return (request, url) => {
    if (request.method !== "GET" || url.pathname !== TMUX_SESSIONS_ROUTE) return undefined;
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
  };
}
