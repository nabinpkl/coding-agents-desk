// Handing a compacted session's context to a session of the other harness, in either direction.
//
// Both directions are one route each, and one route rather than two calls for the same reason:
// the panel must never be left holding a session that was created and never prompted, and the
// only way to guarantee that is for the create and the first turn to be one request the sidecar
// either completes or fails.
//
// What the two directions do NOT share is how the successor is made, and the asymmetry is the
// whole reason this file has two handlers instead of one with a flag:
//
//   to opencode  the serve has a create call and a prompt call, so it is `createSession` then
//                `send` on the registered backend, and the two calls are what the single route
//                makes atomic from the panel's side.
//   to Claude    there is no API at all. `ClaudeLiveBackend` is registered but read-only and
//                throws on both. A Claude session is a tmux pane, so the successor is
//                `launchSession`, and create-plus-first-prompt is literally one argv -- which
//                means this direction cannot strand a session even in principle.
//
// The argv is also where this direction's one real bound comes from. Measured on this project's
// own compacted transcripts, a rendered handover runs 21KB to 68KB, and after the double shell
// quoting on the way into tmux the largest was 68,891 bytes against a `kern.argmax` of 1,048,576
// -- 6.6% of the budget. So argv is not the constraint at any realistic size, and the cap below
// is a guard against pathology that says so out loud rather than letting the kernel answer E2BIG.
//
// It is deliberately NOT the 32,768 of `MAX_LAUNCH_PROMPT`. That number bounds a brief somebody
// TYPED, and its own comment says why: past a few thousand characters a hand-written first turn
// has stopped being one. A handover is rendered rather than written, so it is not the thing that
// cap is about, and raising the shared one would loosen it for the case it was written to catch.

import { findSession } from "@/transcripts/catalog/transcriptCatalog";
import { SUMMARY_TITLE_CHARACTERS } from "@/transcripts/catalog/catalogState";
import { renderOpencodeHandover } from "@/transcripts/opencodeHandover";
import { buildHandoverPrompt, renderHandover, SessionHandoverError } from "@/transcripts/sessionHandover";
import { LIVE_SESSION_LAUNCHER, launchSession, type SessionLauncher } from "@/transcripts/session-ops/forkSession";
import { sessionTitleRefusal } from "@/transcripts/session-ops/sessionTitle";
import type { AgentBackend } from "@/agents/agentBackend";
import { jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";
import { errorResponse, jsonBody, requestIdentifier, routeError } from "@/http/agent-routes/agentRoutes";

const HANDOVER_TO_OPENCODE_ROUTE = "/api/agent-sessions/opencode/handover";
const HANDOVER_TO_CLAUDE_ROUTE = "/api/agent-sessions/claude/handover";

/**
 * Registered beside `createAgentRoutes` rather than inside it, the way the opencode command
 * routes are. It keeps the dependency one-way: these handlers borrow that module's reply and
 * body helpers, and nothing there has to know these exist.
 */
export function createHandoverRoutes(
  resolveBackend: (id: string) => AgentBackend | undefined,
  actions: HandoverRouteActions = LIVE_HANDOVER_ACTIONS,
): RouteHandler {
  return (request, url) => {
    if (request.method === "POST" && url.pathname === HANDOVER_TO_OPENCODE_ROUTE) {
      return handoverToOpencode(request, resolveBackend);
    }
    if (request.method === "POST" && url.pathname === HANDOVER_TO_CLAUDE_ROUTE) {
      return handoverToClaude(request, actions);
    }
    return undefined;
  };
}

/**
 * The two halves of the Claude direction that touch the world, injectable for the same reason
 * `SessionLauncher` is: a test that took the real ones would read a live serve and start a real
 * tmux pane with a real Claude process in it, and it would do that while looking like it passed.
 */
export interface HandoverRouteActions {
  launch: SessionLauncher;
  renderOpencode: typeof renderOpencodeHandover;
}

export const LIVE_HANDOVER_ACTIONS: HandoverRouteActions = {
  launch: LIVE_SESSION_LAUNCHER,
  renderOpencode: renderOpencodeHandover,
};

/**
 * The largest rendered prompt this will put on a command line.
 *
 * A quarter of `kern.argmax`, which leaves the environment and the rest of the argv room they do
 * not remotely need. A session that renders past this is pathological rather than large, and it
 * gets told so: the alternative is `posix_spawn` failing with E2BIG somewhere inside tmux, which
 * surfaces as a pane that never appeared.
 */
export const MAX_HANDOVER_PROMPT = 256 * 1024;

/**
 * Start an opencode session carrying a compacted Claude session's context.
 *
 * Claude only as the source: any other is rejected rather than rendered by a rule written for
 * Claude records.
 */
export async function handoverToOpencode(
  request: Request,
  resolveBackend: (id: string) => AgentBackend | undefined,
): Promise<Response> {
  try {
    const body = await jsonBody(request);
    const requestId = requestIdentifier(body.requestId);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const message = typeof body.message === "string" ? body.message : "";
    if (!requestId || !sessionId) {
      return errorResponse("invalid-request", "requestId and sessionId are required", 400, requestId ?? undefined);
    }
    const source = findSession("claude", sessionId);
    if (!source || !source.transcriptPath) {
      return errorResponse("unknown-session", `claude session "${sessionId}" was not found`, 404, requestId);
    }
    const backend = resolveBackend("opencode");
    if (!backend) return errorResponse("unknown-source", `agent source "opencode" is not registered`, 404, requestId);
    let handover;
    try {
      handover = await renderHandover(sessionId, source.transcriptPath);
    } catch (error) {
      if (error instanceof SessionHandoverError) {
        return errorResponse("no-compaction-point", error.message, 404, requestId);
      }
      throw error;
    }
    const prompt = buildHandoverPrompt({ source: "claude", sessionId, handover, message });
    const created = await backend.createSession(`${requestId}-create`, source.project);
    await backend.send(created.sessionId, `${requestId}-send`, prompt, "next");
    return jsonResponse({
      session: created,
      handover: { turnCount: handover.turnCount, chars: prompt.length, lossy: handover.lossy },
    }, 201);
  } catch (error) {
    return routeError(error);
  }
}

/**
 * Start a Claude session carrying a compacted opencode session's context.
 *
 * The mirror of the route above, and the same refusals: opencode only as the source, and a
 * session with no landed compaction is refused rather than handed over as a long paste.
 *
 * The new session runs where the source runs. Not a worktree: a handover continues a piece of
 * work rather than branching it, so putting the successor somewhere else would leave it looking
 * at a tree its own context does not describe.
 */
export async function handoverToClaude(
  request: Request,
  actions: HandoverRouteActions = LIVE_HANDOVER_ACTIONS,
): Promise<Response> {
  try {
    const body = await jsonBody(request);
    const requestId = requestIdentifier(body.requestId);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const message = typeof body.message === "string" ? body.message : "";
    if (!requestId || !sessionId) {
      return errorResponse("invalid-request", "requestId and sessionId are required", 400, requestId ?? undefined);
    }
    const source = findSession("opencode", sessionId);
    if (!source) {
      return errorResponse("unknown-session", `opencode session "${sessionId}" was not found`, 404, requestId);
    }
    const title = handoverTitle(body.title, source.title);
    const refusal = sessionTitleRefusal(title);
    if (refusal) return errorResponse("invalid-request", `title: ${refusal}`, 400, requestId);

    let handover;
    try {
      handover = await actions.renderOpencode(sessionId);
    } catch (error) {
      if (error instanceof SessionHandoverError) {
        return errorResponse("no-compaction-point", error.message, 404, requestId);
      }
      throw error;
    }
    const prompt = buildHandoverPrompt({ source: "opencode", sessionId, handover, message });
    if (prompt.length > MAX_HANDOVER_PROMPT) {
      return errorResponse(
        "handover-too-large",
        `the rendered handover is ${prompt.length} characters, past the ${MAX_HANDOVER_PROMPT} a first turn can carry`,
        413,
        requestId,
      );
    }
    const started = await launchSession({ checkout: source.project, title, prompt }, actions.launch);
    return jsonResponse({
      session: started,
      handover: { turnCount: handover.turnCount, chars: prompt.length, lossy: handover.lossy },
    }, 201);
  } catch (error) {
    return routeError(error);
  }
}

/**
 * What to call the session that continues the work.
 *
 * The source's own title with a suffix, so a roster shows the pair next to each other rather than
 * a name that says nothing about where it came from. Trimmed from the FRONT of the borrowed part
 * when it would run past the catalog's cap, because the suffix is the part that has to survive:
 * a title cut to exactly the source's own would read as a duplicate row.
 */
function handoverTitle(requested: unknown, sourceTitle: string | undefined): string {
  if (typeof requested === "string" && requested.trim()) return requested.trim();
  const suffix = " (handover)";
  const base = (sourceTitle ?? "").trim() || "opencode session";
  const room = SUMMARY_TITLE_CHARACTERS - suffix.length;
  return `${base.length > room ? base.slice(0, room) : base}${suffix}`;
}
