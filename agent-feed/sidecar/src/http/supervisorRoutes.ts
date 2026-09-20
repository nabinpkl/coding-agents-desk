// `POST /api/supervisor` -- the one thing this process does on its PARENT's behalf.
//
// The supervisor owns the sidecar as a child (`agent-feed/sidecar/src/supervisor.ts`). It has no
// port, nothing listens for it, and the panel that wants to tell it something is usually on another
// machine entirely. So the request is left on the same rendezvous board the supervisor already
// publishes its state to, and picked up there within the second.
//
// What it carries is the reader's answer to a question the parser cannot answer for them: whether a
// tree that parses perfectly is worth restarting into right now. It is not free -- every stream the
// panel is holding dies with the process, the desktop encoders go with it, and terminals re-import
// their scrollback.

import type { SupervisorCommandRequest } from "@agentdesk/agent-feed-wire";
import { requestSupervisor } from "@/sidecarRegistry";
import { jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";

const SUPERVISOR_ROUTE = "/api/supervisor";

/**
 * @param board where the request is left. The real rendezvous directory unless a test says
 * otherwise, and it is NOT under the runtime root: the board is shared between login sessions and
 * lives at a fixed path, so the usual runtime-root override does not move it out of the way.
 */
export function createSupervisorRoutes(board?: string): RouteHandler {
  return (request, url) => {
    if (request.method !== "POST") return undefined;
    if (url.pathname !== SUPERVISOR_ROUTE) return undefined;

    return request.json().then(
      (body) => {
        const command = (body as Partial<SupervisorCommandRequest> | null)?.command;
        if (command !== "auto" && command !== "manual" && command !== "apply") {
          return new Response("unknown supervisor command", { status: 400 });
        }
        // Answered with the standing request as it now reads, so a caller learns what this machine
        // is actually being asked for rather than assuming its own word landed.
        return jsonResponse(requestSupervisor(command, board));
      },
      // A body that is not JSON is a caller that has drifted from the contract, and answering 200
      // would leave a panel showing a mode this machine was never put in.
      () => new Response("expected a JSON body", { status: 400 }),
    );
  };
}
