// The panel's way into an SDK session's runner (ADR-0143).
//
//   GET  /api/sessions/claude/:id/sdk/stream     the runner's state, whole, on every change
//   POST /api/sessions/claude/:id/sdk/prompt     { text }
//   POST /api/sessions/claude/:id/sdk/answer     { answers }  -> the terminal dialog's outcome shape
//   POST /api/sessions/claude/:id/sdk/decide     { toolUseId, allow, message? }
//   POST /api/sessions/claude/:id/sdk/mode       { mode }
//   POST /api/sessions/claude/:id/sdk/model      { model }
//   POST /api/sessions/claude/:id/sdk/effort     { effort }
//   POST /api/sessions/claude/:id/sdk/interrupt
//   POST /api/sessions/claude/:id/sdk/switch       { mode }  -> moves a live, idle session between modes
//
// Here rather than under `http/` for the reason `messaging/hubRoutes.ts` is: the routes are this
// feature's surface and nothing else serves them.

import type {
  ClaudeSdkCommandOutcome,
  ClaudeSdkSwitchOutcome,
  ClaudeSdkRefusal,
  TmuxQuestionAnswer,
  TmuxQuestionOutcome,
  TmuxQuestionRefusal,
} from "@agentdesk/agent-feed-wire";
import { NO_RUNNER, sharedClaudeSdkClient, type ClaudeSdkClient } from "@/claude-sdk/session/claudeSdkClient";
import { isPromptImageType } from "@/claude-sdk/claudeSdkProtocol";
import { parseSessionCommand, type SessionCommand, type SessionReply } from "@/claude-sdk/session/claudeSdkCommands";
import { ClaudeSdkLiveFeed, type RunnerStreamTarget } from "@/claude-sdk/session/claudeSdkLiveFeed";
import { liveSwitchSteps, switchRunMode, type SwitchSteps } from "@/claude-sdk/claudeSdkSwitch";
import { findSession } from "@/transcripts/catalog/transcriptCatalog";
import { parseMessageAttachments } from "@/agents/agentBackend";
import {
  encodeServerSentEvent,
  errorResponse,
  jsonResponse,
  startServerSentEventStream,
} from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const SDK_ROUTE =
  /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/sdk\/(stream|prompt|answer|decide|mode|model|effort|interrupt|switch)$/i;

/** How long `EventSource` waits before asking again once a stream ends. */
const RETRY = new TextEncoder().encode("retry: 5000\n\n");

const MAXIMUM_BODY_BYTES = 1024 * 1024;
/** A prompt may carry images: five of 8 MiB, base64'd, which is what `parseMessageAttachments` allows. */
const MAXIMUM_PROMPT_BODY_BYTES = 60 * 1024 * 1024;

/**
 * Mounted ahead of the session routes, whose catch-all refuses an `/api/sessions/` path it does not
 * know. One client for the process: it holds a connection per session somebody is looking at, and
 * hands what those runners stream to the live mirror.
 */
export function createClaudeSdkRoutes(
  live: RunnerStreamTarget | null = null,
  client: ClaudeSdkClient = sharedClaudeSdkClient(live ? new ClaudeSdkLiveFeed(live) : null),
): RouteHandler {
  return (request, url, server) => {
    const match = SDK_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    const sessionId = match[1]!.toLowerCase();
    const action = match[2]!.toLowerCase();
    if (action === "stream") {
      if (request.method !== "GET") return undefined;
      return startServerSentEventStream(request, server, (write) => {
        write(RETRY);
        return client.observe(sessionId, (state) => write(encodeServerSentEvent(state)));
      });
    }
    if (request.method !== "POST") return undefined;
    if (action === "switch") return switchMode(client, request, sessionId);
    return command(client, request, sessionId, action);
  };
}

async function body(request: Request, limit = MAXIMUM_BODY_BYTES): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > limit) return null;
  if (!text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The command a request describes, validated field by field before anything reaches a runner.
 */
function sessionCommand(action: string, fields: Record<string, unknown>): SessionCommand | null {
  const type = action === "mode" || action === "model" || action === "effort" ? `set-${action}` : action;
  return parseSessionCommand({ ...fields, type });
}

async function command(
  client: ClaudeSdkClient,
  request: Request,
  sessionId: string,
  action: string,
): Promise<Response> {
  const fields = await body(request, action === "prompt" ? MAXIMUM_PROMPT_BODY_BYTES : MAXIMUM_BODY_BYTES);
  if (fields && action === "prompt" && fields.files !== undefined) {
    // The panel sends images the way it sends them to opencode; the runner takes them as the API does.
    let files: ReturnType<typeof parseMessageAttachments>;
    try {
      files = parseMessageAttachments(fields.files);
    } catch (error) {
      return errorResponse("invalid-request", error instanceof Error ? error.message : String(error), 400);
    }
    const unsupported = files.find((file) => !isPromptImageType(file.mime));
    if (unsupported)
      return errorResponse("invalid-request", `"${unsupported.name}" is not a PNG, JPEG, GIF or WebP image`, 400);
    fields.images = files.map((file) => ({ mediaType: file.mime, data: file.data.replace(/\s+/g, "") }));
    delete fields.files;
  }
  const parsed = fields ? sessionCommand(action, fields) : null;
  if (action === "answer") {
    if (!parsed || parsed.type !== "answer")
      return errorResponse("invalid-request", "answers must describe every question", 400);
    return jsonResponse(answerOutcome(parsed.answers, await client.command(sessionId, parsed)));
  }
  if (!parsed) return errorResponse("invalid-request", `the body does not describe a ${action} command`, 400);
  return jsonResponse(commandOutcome(await client.command(sessionId, parsed)));
}

const COMMAND_REFUSALS: ReadonlySet<string> = new Set<ClaudeSdkRefusal>(["not-pending", "invalid", "failed"]);

export function commandOutcome(reply: SessionReply): ClaudeSdkCommandOutcome {
  if (reply.ok) return { ok: true };
  if (reply === NO_RUNNER) return { ok: false, reason: "no-runner", message: reply.message };
  const reason = COMMAND_REFUSALS.has(reply.reason) ? (reply.reason as ClaudeSdkRefusal) : "failed";
  return { ok: false, reason, message: reply.message };
}

/**
 * An answer's outcome in the terminal dialog's words, carrying back every word the reader typed.
 *
 * Nothing is ever half-sent here -- the runner settles the call with every answer or none -- except
 * when the reply never came, which cannot be told apart from one that landed; that is the
 * dialog's own "what landed cannot be established".
 */
export function answerOutcome(answers: readonly TmuxQuestionAnswer[], reply: SessionReply): TmuxQuestionOutcome {
  if (reply.ok) return { answered: true };
  const keptText = answers
    .filter((answer) => answer.other.trim())
    .map((answer) => ({ question: answer.question, text: answer.other }));
  const reason: TmuxQuestionRefusal =
    reply === NO_RUNNER
      ? "no-pane"
      : reply.reason === "no-dialog" || reply.reason === "wrong-dialog" || reply.reason === "wrong-option"
        ? reply.reason
        : reply.reason === "not-pending"
          ? "no-dialog"
          : "pane-stalled";
  return { answered: false, reason, keptText, sent: false };
}

/**
 * Moves a live, idle session to the other mode. The catalog supplies where it runs and what it is
 * called, which a resume needs and the request does not get to choose.
 */
export async function switchMode(
  client: ClaudeSdkClient,
  request: Request,
  sessionId: string,
  steps: SwitchSteps = liveSwitchSteps(client),
): Promise<Response> {
  const fields = await body(request);
  const mode = fields?.mode;
  if (mode !== "terminal" && mode !== "sdk") {
    return jsonResponse(
      { ok: false, reason: "invalid", message: "mode must be terminal or sdk" } satisfies ClaudeSdkSwitchOutcome,
      400,
    );
  }
  const session = findSession("claude", sessionId);
  if (!session) {
    return jsonResponse(
      {
        ok: false,
        reason: "not-running",
        message: "this session is not in the catalog",
      } satisfies ClaudeSdkSwitchOutcome,
      404,
    );
  }
  const outcome = await switchRunMode(
    { sessionId, cwd: session.project, title: session.title ?? sessionId },
    mode,
    steps,
  );
  return jsonResponse(outcome satisfies ClaudeSdkSwitchOutcome);
}
