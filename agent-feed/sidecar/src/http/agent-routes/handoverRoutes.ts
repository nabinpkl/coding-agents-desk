// Handing a session's context to a session of the other harness, in either direction,
// and reading what that context currently amounts to without handing it anywhere.
//
// Three routes over one reader. The read is a GET on the session itself and starts nothing, which
// is why it is separate: asking what a session's context amounts to should not commit anyone to
// continuing it. It exists because the summary is worth having on its own -- it is the statement
// of what a long session is currently working from, and until now the only way to see one was to
// start a successor and read its first turn.
//
// Both write directions are one route each, and one route rather than two calls for the same
// reason: the panel must never be left holding a session that was created and never prompted, and
// the only way to guarantee that is for the create and the first turn to be one request the
// sidecar either completes or fails.
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
// own compacted transcripts, a rendered handover runs 21KB to 68KB; a session that never compacted
// is handed over whole and runs longer -- 273KB for one five-hour opencode session, nearly all of it
// the model's own prose, since tool output is cut to head and tail either way. None of that fits
// tmux's own command message, which refuses past about 16KB, so the turn travels to the pane in a
// file (`firstTurnFromFile`) and reaches the CLI's argv from there. What bounds it is then the
// kernel's argv limit, and the cap below says so out loud rather than letting exec answer E2BIG.
//
// It is deliberately NOT the 32,768 of `MAX_LAUNCH_PROMPT`. That number bounds a brief somebody
// TYPED, and its own comment says why: past a few thousand characters a hand-written first turn
// has stopped being one. A handover is rendered rather than written, so it is not the thing that
// cap is about, and raising the shared one would loosen it for the case it was written to catch.

import { findSession } from "@/transcripts/catalog/transcriptCatalog";
import type { Session } from "@/transcripts/transcriptTypes";
import { SUMMARY_TITLE_CHARACTERS } from "@/transcripts/catalog/catalogState";
import { renderOpencodeHandover } from "@/transcripts/opencodeHandover";
import {
  buildHandoverPrompt,
  renderHandover,
  SessionHandoverError,
  type RenderedHandover,
} from "@/transcripts/sessionHandover";
import { LIVE_SESSION_LAUNCHER, launchSession, type SessionLauncher } from "@/transcripts/session-ops/forkSession";
import { sessionTitleRefusal } from "@/transcripts/session-ops/sessionTitle";
import type { AgentBackend } from "@/agents/agentBackend";
import { jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";
import { errorResponse, jsonBody, requestIdentifier, routeError } from "@/http/agent-routes/agentRoutes";

const HANDOVER_TO_OPENCODE_ROUTE = "/api/agent-sessions/opencode/handover";
const HANDOVER_TO_CLAUDE_ROUTE = "/api/agent-sessions/claude/handover";
/**
 * Reading a session's own handover, addressed by the session rather than by a destination.
 *
 * Under `/api/sessions/` because the two POSTs above are named for where a successor is STARTED,
 * and this starts nothing: it answers what a session's context currently amounts to. A reader
 * that only wants the summary reads `summary` and ignores the rest.
 */
const HANDOVER_READ_ROUTE = /^\/api\/sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/handover$/;

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
      return handoverToOpencode(request, resolveBackend, actions);
    }
    if (request.method === "POST" && url.pathname === HANDOVER_TO_CLAUDE_ROUTE) {
      return handoverToClaude(request, actions);
    }
    const read = HANDOVER_READ_ROUTE.exec(url.pathname);
    if (request.method === "GET" && read) {
      return readHandover(read[1]!, read[2]!, actions);
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
  renderClaude: typeof renderHandover;
  renderOpencode: typeof renderOpencodeHandover;
  /** The Bots a Claude successor can land on; absent where no registry is wired. */
  bots?: HandoverBots;
}

/**
 * Putting a Claude successor on the Bot the handover was asked from, inside the one request.
 *
 * Here rather than as the panel's second call, because that call races the session it attaches:
 * it resolves the session against the catalog, and a Claude session started a moment ago is not
 * in it until its first turn writes the transcript. The first real handover lost that race and
 * answered "session claude:<id> is not in the current catalog" (2026-10-11). The opencode
 * direction has no such gap, because the serve's create puts the session in the catalog before
 * the route answers.
 */
export interface HandoverBots {
  /** Asked BEFORE anything starts, so a stale Bot id costs an error rather than a stray pane. */
  exists(botId: string): Promise<boolean>;
  attach(botId: string, ref: { source: "claude"; sessionId: string }): Promise<void>;
}

export const LIVE_HANDOVER_ACTIONS: HandoverRouteActions = {
  launch: LIVE_SESSION_LAUNCHER,
  renderClaude: renderHandover,
  renderOpencode: renderOpencodeHandover,
};

/**
 * What a session's context amounts to right now, or why it amounts to nothing.
 *
 * One reader for all three routes, because "which sessions can be handed over, and how is each
 * one read" is one question and three answers to it would drift: the GET would offer a handover
 * the POST then refused, or the other way round, and neither would look wrong on its own.
 *
 * A union rather than a thrown error so each caller keeps its own status and its own wording,
 * which is the same reason `sessionTitleRefusal` returns a reason instead of throwing.
 */
type HandoverRead =
  | { ok: true; session: Session; handover: RenderedHandover }
  | { ok: false; code: string; message: string; status: number };

async function readSessionHandover(
  source: string,
  sessionId: string,
  actions: HandoverRouteActions,
): Promise<HandoverRead> {
  if (source !== "claude" && source !== "opencode") {
    return {
      ok: false,
      code: "unsupported-source",
      // Named rather than silently empty: Codex and Pi are dormant providers, but their sessions
      // are still real rows in the same lists, and a reader told only "not found" would go
      // looking for the session.
      message: `"${source}" sessions cannot be handed over`,
      status: 400,
    };
  }
  const session = findSession(source, sessionId);
  const missing: HandoverRead = {
    ok: false,
    code: "unknown-session",
    message: `${source} session "${sessionId}" was not found`,
    status: 404,
  };
  if (!session) return missing;
  if (source === "opencode") {
    return rendered(session, () => actions.renderOpencode(sessionId));
  }
  // Bound before the check rather than read twice, so the render takes a string the type system
  // has already proved rather than one asserted past it.
  const transcriptPath = session.transcriptPath;
  if (!transcriptPath) return missing;
  return rendered(session, () => actions.renderClaude(sessionId, transcriptPath));
}

/** Turns the one refusal a render can make into the union, and lets every other failure out. */
async function rendered(
  session: Session,
  render: () => Promise<RenderedHandover>,
): Promise<HandoverRead> {
  try {
    return { ok: true, session, handover: await render() };
  } catch (error) {
    if (error instanceof SessionHandoverError) {
      return { ok: false, code: "nothing-to-hand-over", message: error.message, status: 404 };
    }
    throw error;
  }
}

/**
 * The summary a session is currently running on and the turns since it, or, for one that never
 * compacted, a null summary and every turn.
 *
 * Read-only and starts nothing, which is the whole point of it being separate from the two POSTs:
 * asking what a session's context amounts to should not commit anyone to continuing it somewhere.
 */
async function readHandover(
  source: string,
  sessionId: string,
  actions: HandoverRouteActions,
): Promise<Response> {
  try {
    const read = await readSessionHandover(source, sessionId, actions);
    if (!read.ok) return errorResponse(read.code, read.message, read.status);
    return jsonResponse({
      source,
      sessionId,
      title: read.session.title ?? null,
      project: read.session.project,
      summary: read.handover.summary,
      turns: read.handover.turns,
      turnCount: read.handover.turnCount,
      lossy: read.handover.lossy,
    });
  } catch (error) {
    return routeError(error);
  }
}

/**
 * The largest rendered prompt, in bytes, this will hand the CLI as one argument.
 *
 * Half of macOS's `kern.argmax` (1,048,576), which leaves the environment and the rest of the argv
 * more room than they need. Linux is tighter in a different way: one argument may not exceed
 * `MAX_ARG_STRLEN`, 128KB including its terminator, however much total room there is. Past this
 * the reader is told, because the alternative is `exec` failing with E2BIG inside the pane, which
 * surfaces as a pane sitting at a shell prompt with no session in it.
 */
export const MAX_HANDOVER_PROMPT = process.platform === "linux" ? 128 * 1024 - 1 : 512 * 1024;

/**
 * Start an opencode session carrying a Claude session's context.
 *
 * Claude only as the source: any other is rejected rather than rendered by a rule written for
 * Claude records.
 */
export async function handoverToOpencode(
  request: Request,
  resolveBackend: (id: string) => AgentBackend | undefined,
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
    const backend = resolveBackend("opencode");
    if (!backend) return errorResponse("unknown-source", `agent source "opencode" is not registered`, 404, requestId);
    const read = await readSessionHandover("claude", sessionId, actions);
    if (!read.ok) return errorResponse(read.code, read.message, read.status, requestId);
    const { session: source, handover } = read;
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
 * Start a Claude session carrying an opencode session's context.
 *
 * The mirror of the route above, and the same refusals: opencode only as the source, and a
 * session with nothing in it, or whose newest compaction has no readable summary, is refused.
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
    const read = await readSessionHandover("opencode", sessionId, actions);
    if (!read.ok) return errorResponse(read.code, read.message, read.status, requestId);
    const { session: source, handover } = read;
    // Checked after the render rather than before it, so a session that cannot be handed over at
    // all says so instead of complaining about the name it would have been given.
    const title = handoverTitle(body.title, source.title);
    const refusal = sessionTitleRefusal(title);
    if (refusal) return errorResponse("invalid-request", `title: ${refusal}`, 400, requestId);
    const botId = typeof body.botId === "string" && body.botId ? body.botId : null;
    if (botId !== null && !await actions.bots?.exists(botId)) {
      return errorResponse("unknown-bot", `Bot "${botId}" was not found`, 404, requestId);
    }

    const prompt = buildHandoverPrompt({ source: "opencode", sessionId, handover, message });
    const bytes = Buffer.byteLength(prompt);
    if (bytes > MAX_HANDOVER_PROMPT) {
      return errorResponse(
        "handover-too-large",
        `the rendered handover is ${bytes} bytes, past the ${MAX_HANDOVER_PROMPT} a first turn can carry`,
        413,
        requestId,
      );
    }
    const started = await launchSession({ checkout: source.project, title, prompt }, actions.launch);
    if (botId !== null) await actions.bots!.attach(botId, { source: "claude", sessionId: started.sessionId });
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
