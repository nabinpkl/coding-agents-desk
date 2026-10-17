// Whether a Claude session is running as a terminal CLI process, and in which tmux pane.
//
// Read-only: the panel asks it to choose a composer, so it has no side effects, and since
// 2026-10-16 there is nothing here that writes to a session at all (see `wire/cliSession.ts`).
// Claude-only by the route pattern rather than a runtime check, because the registry it reads is
// Claude Code's.

import type { CliSessionStatus } from "@agentdesk/agent-feed-wire";
import { cliSessionStatus } from "@/input/claudeCliSession";
import { jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const CLI_SESSION_ROUTE = /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/cli$/i;

export function createCliSessionRoutes(
  status: (sessionId: string) => Promise<CliSessionStatus> = (sessionId) => cliSessionStatus(sessionId),
): RouteHandler {
  return (request, url) => {
    const match = CLI_SESSION_ROUTE.exec(url.pathname);
    if (!match || request.method !== "GET") return undefined;
    return status(match[1]!.toLowerCase()).then((answer) => jsonResponse(answer));
  };
}
