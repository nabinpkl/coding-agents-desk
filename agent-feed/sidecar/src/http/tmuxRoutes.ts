// `GET /api/tmux/sessions` -- what the terminal grid can attach to -- and
// `DELETE /api/tmux/sessions/:name` -- ending one on purpose.
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

import type { TmuxSessionSummary } from "@agentdesk/agent-feed-wire";
import { killTmuxSession, listTmuxSessions, TmuxUnavailable } from "@/terminal/tmux/tmuxSessions";
import { jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";

const TMUX_SESSIONS_ROUTE = "/api/tmux/sessions";
const TMUX_SESSION_ROUTE_PATTERN = /^\/api\/tmux\/sessions\/([^/]+)$/;

export function createTmuxRoutes(
  list: () => Promise<TmuxSessionSummary[]> = listTmuxSessions,
  kill: (session: string) => Promise<void> = killTmuxSession,
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
