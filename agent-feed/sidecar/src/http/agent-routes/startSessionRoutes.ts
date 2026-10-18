// Starting a session that belongs to nobody, in a directory the reader picked, in its own pane.
//
// One route for both harnesses because the reader asks one question -- "a new session, here, in
// this harness" -- and the panel must not have to know that the two answers are built differently:
//
//   Claude    there is no API. A Claude session is a tmux pane, so this is `launchSession`, the one
//             path every other start takes, and the first turn rides the argv.
//   opencode  the serve owns the session, so it is created and named there, then its TUI is
//             started in a pane at once rather than on the first terminal that joins it, and the
//             first turn is sent to the serve.
//
// Not attached to any Bot. The panel offers that afterwards, the way it does for every other session
// a Bot does not hold, which keeps this route free of the Bot registry's anchors and slots.

import type { StartedSourceSession } from "@agentdesk/agent-feed-wire";
import type { AgentBackend, AgentMessageDelivery } from "@/agents/agentBackend";
import {
  LIVE_SESSION_LAUNCHER,
  launchSession,
  MAX_LAUNCH_PROMPT,
  type SessionLauncher,
} from "@/transcripts/session-ops/forkSession";
import { sessionTitleRefusal } from "@/transcripts/session-ops/sessionTitle";
import { opencodeBinary } from "@/config/configBinaries";
import { startOpencodeSessionPane } from "@/terminal/session-panes/opencodeSessionLaunch";
import { jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import {
  errorResponse,
  jsonBody,
  projectNotFound,
  requestIdentifier,
  routeError,
  startableProjectPath,
} from "@/http/agent-routes/agentRoutes";

const START_ROUTE = "/api/agent-sessions/start";

/**
 * The parts that touch the world, injectable for the reason `SessionLauncher` is: a test holding
 * the real ones would start real tmux panes with real agents in them while looking like it passed.
 */
export interface StartSessionActions {
  launch: SessionLauncher;
  /** Whether opencode's TUI can be started here, asked before the serve makes anything. */
  opencodeInstalled: () => boolean;
  startOpencodePane: typeof startOpencodeSessionPane;
  /** The canonical directory a session may start in, or null; see `startableProjectPath`. */
  projectPath: (requested: string) => Promise<string | null>;
}

export const LIVE_START_SESSION_ACTIONS: StartSessionActions = {
  launch: LIVE_SESSION_LAUNCHER,
  opencodeInstalled: () => opencodeBinary() !== null,
  startOpencodePane: (options) => startOpencodeSessionPane(options),
  projectPath: (requested) => startableProjectPath(requested),
};

/** The opencode backend surface a start needs; the rename is opencode's own, not `AgentBackend`'s. */
interface OpencodeStartBackend {
  createSession: AgentBackend["createSession"];
  renameSession(sessionId: string, title: string): Promise<void>;
  send(sessionId: string, requestId: string, text: string, delivery: AgentMessageDelivery): Promise<unknown>;
}

export function createStartSessionRoutes(
  resolveBackend: (id: string) => AgentBackend | undefined,
  actions: StartSessionActions = LIVE_START_SESSION_ACTIONS,
): RouteHandler {
  return (request, url) => {
    if (request.method === "POST" && url.pathname === START_ROUTE) {
      return startSession(request, resolveBackend, actions);
    }
    return undefined;
  };
}

async function startSession(
  request: Request,
  resolveBackend: (id: string) => AgentBackend | undefined,
  actions: StartSessionActions,
): Promise<Response> {
  try {
    const body = await jsonBody(request);
    const requestId = requestIdentifier(body.requestId);
    if (!requestId) return errorResponse("invalid-request", "requestId is required", 400);
    const source = body.source;
    if (source !== "claude" && source !== "opencode") {
      return errorResponse("invalid-request", "source must be claude or opencode", 400, requestId);
    }
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const refusal = sessionTitleRefusal(title);
    if (refusal) return errorResponse("invalid-request", `title: ${refusal}`, 400, requestId);
    if (body.prompt !== undefined && typeof body.prompt !== "string") {
      return errorResponse("invalid-request", "prompt must be a string", 400, requestId);
    }
    if (typeof body.prompt === "string" && body.prompt.length > MAX_LAUNCH_PROMPT) {
      return errorResponse("invalid-request", `prompt cannot exceed ${MAX_LAUNCH_PROMPT} characters`, 400, requestId);
    }
    const claudeMode = body.claudeMode;
    if (claudeMode !== undefined && claudeMode !== "terminal" && claudeMode !== "sdk") {
      return errorResponse("invalid-request", "claudeMode must be terminal or sdk", 400, requestId);
    }
    if (claudeMode !== undefined && source !== "claude") {
      return errorResponse("invalid-request", "claudeMode is for claude sessions", 400, requestId);
    }
    // Trimmed at the ends only: the first turn's line breaks are the reader's.
    const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : undefined;
    const requested = typeof body.projectPath === "string" ? body.projectPath : "";
    const projectPath = requested ? await actions.projectPath(requested) : null;
    if (!projectPath) return projectNotFound(requestId);

    if (source === "claude") {
      const started = await launchSession(
        {
          checkout: projectPath,
          title,
          ...(prompt === undefined ? {} : { prompt }),
          ...(claudeMode === undefined ? {} : { claudeMode }),
        },
        actions.launch,
      );
      return jsonResponse({ source, ...started } satisfies StartedSourceSession, 201);
    }
    return await startOpencode(resolveBackend, actions, { requestId, projectPath, title, prompt });
  } catch (error) {
    return routeError(error);
  }
}

async function startOpencode(
  resolveBackend: (id: string) => AgentBackend | undefined,
  actions: StartSessionActions,
  plan: { requestId: string; projectPath: string; title: string; prompt: string | undefined },
): Promise<Response> {
  const backend = resolveBackend("opencode") as unknown as OpencodeStartBackend | undefined;
  if (!backend)
    return errorResponse("unknown-source", `agent source "opencode" is not registered`, 404, plan.requestId);
  // Before the serve makes anything, so a machine without the TUI refuses rather than leaving a
  // session that has no pane to watch it in.
  if (!actions.opencodeInstalled()) {
    return errorResponse("opencode-unavailable", "opencode is not installed on this machine", 503, plan.requestId);
  }
  const created = await backend.createSession(`${plan.requestId}-create`, plan.projectPath);
  // Past this point the session exists, so a failure says so rather than reading as nothing
  // having happened: a reader who retried on "could not start" would make a second one.
  let step = "naming it";
  try {
    await backend.renameSession(created.sessionId, plan.title);
    step = "opening its pane";
    const tmuxSession = await actions.startOpencodePane({
      sessionId: created.sessionId,
      cwd: plan.projectPath,
      title: plan.title,
    });
    if (plan.prompt) {
      step = "sending its first message";
      await backend.send(created.sessionId, `${plan.requestId}-send`, plan.prompt, "next");
    }
    const started: StartedSourceSession = {
      source: "opencode",
      sessionId: created.sessionId,
      title: plan.title,
      projectPath: plan.projectPath,
      tmuxSession,
    };
    return jsonResponse(started, 201);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return errorResponse(
      "session-setup-failed",
      `the opencode session ${created.sessionId} was created, but ${step} failed: ${reason}`,
      500,
      plan.requestId,
    );
  }
}
