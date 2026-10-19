// Starting a chat with no project: a folder of its own, a name from its first message, and a
// Claude session through the Agent SDK whose first turn is the scratch brief and that message.
//
// One request for all three, because the panel must never hold a folder with no session in it or
// a session with no first turn: the Chat box sends nothing until the person does, and this either
// starts the chat or leaves no trace of having tried. The SDK rather than the terminal because a
// new folder makes Claude's terminal ask whether to trust it, every chat, and the runner does not
// ask; the runner is also what lets the panel open the chat straight into its session view.

import type { StartedSourceSession } from "@agentdesk/agent-feed-wire";
import { jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import { errorResponse, jsonBody, requestIdentifier, routeError } from "@/http/agent-routes/agentRoutes";
import {
  LIVE_SESSION_LAUNCHER,
  launchSession,
  MAX_LAUNCH_PROMPT,
  type SessionLauncher,
} from "@/transcripts/session-ops/forkSession";
import { makeScratchFolder, removeScratchFolder } from "@/scratch/scratchFolders";
import { scratchFirstTurn, scratchTitle } from "@/scratch/scratchBrief";

const START_SCRATCH_ROUTE = "/api/agent-sessions/start-scratch";

/** The parts that touch the world, injectable so a test starts no pane and makes no folder. */
export interface ScratchSessionActions {
  launch: SessionLauncher;
  makeFolder: (title: string) => Promise<string>;
  removeFolder: (path: string) => Promise<void>;
}

export const LIVE_SCRATCH_SESSION_ACTIONS: ScratchSessionActions = {
  launch: LIVE_SESSION_LAUNCHER,
  makeFolder: (title) => makeScratchFolder(title),
  removeFolder: (path) => removeScratchFolder(path),
};

export function createScratchSessionRoutes(
  actions: ScratchSessionActions = LIVE_SCRATCH_SESSION_ACTIONS,
): RouteHandler {
  return (request, url) => {
    if (request.method === "POST" && url.pathname === START_SCRATCH_ROUTE) return startScratch(request, actions);
    return undefined;
  };
}

async function startScratch(request: Request, actions: ScratchSessionActions): Promise<Response> {
  try {
    const body = await jsonBody(request);
    const requestId = requestIdentifier(body.requestId);
    if (!requestId) return errorResponse("invalid-request", "requestId is required", 400);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return errorResponse("invalid-request", "a chat starts with a message", 400, requestId);
    if (prompt.length > MAX_LAUNCH_PROMPT) {
      return errorResponse("invalid-request", `prompt cannot exceed ${MAX_LAUNCH_PROMPT} characters`, 400, requestId);
    }

    const title = scratchTitle(prompt);
    const folder = await actions.makeFolder(title);
    let started;
    try {
      started = await launchSession(
        { checkout: folder, title, prompt: scratchFirstTurn(folder, prompt), claudeMode: "sdk" },
        actions.launch,
      );
    } catch (error) {
      // The folder was made by this request and nothing has run in it, so it goes with the start
      // that failed. A folder that is somehow no longer empty stays, and says so beside the cause.
      await actions.removeFolder(folder).catch((removal: unknown) => {
        console.error(
          JSON.stringify({
            event: "scratch-folder-left",
            folder,
            reason: removal instanceof Error ? removal.message : String(removal),
          }),
        );
      });
      throw error;
    }
    return jsonResponse({ source: "claude", ...started } satisfies StartedSourceSession, 201);
  } catch (error) {
    return routeError(error);
  }
}
