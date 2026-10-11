import { backendPage, parseMessageAttachments, stampSessionModel, type AgentBackend, type AgentCommandReceipt, type AgentMessageDelivery } from "@/agents/agentBackend";
import { eventsPageAtFromQuery } from "@agentdesk/agent-feed-wire";
import { AgentCommandConflictError, AgentModeUnsupportedError, AgentSessionNotFoundError } from "@/agents/piAgentBackend";
import { canonicalProjectPath, findSession, getSnapshot } from "@/transcripts/catalog/transcriptCatalog";
import type { EventMode, TokenUsage } from "@/transcripts/transcriptTypes";
import { encodeServerSentEvent, jsonResponse, startServerSentEventStream } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import { bindableDirectory } from "@/bots/botDirectory";

const CREATE_ROUTE = "/api/agent-sessions";
const MESSAGE_ROUTE = /^\/api\/agent-sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/messages$/;
const ABORT_ROUTE = /^\/api\/agent-sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/abort$/;
const UI_STREAM_ROUTE = /^\/api\/agent-sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/ui\/stream$/;
const UI_RESPONSE_ROUTE = /^\/api\/agent-sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/ui\/([A-Za-z0-9._:-]{1,128})$/;
const EVENT_ROUTE = /^\/api\/sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/events$/;
const STREAM_ROUTE = /^\/api\/sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/stream$/;
const LIVE_EVENT_ROUTE = /^\/api\/agent-sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/events$/;
const LIVE_STREAM_ROUTE = /^\/api\/agent-sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/stream$/;
const MAXIMUM_BODY_BYTES = 256 * 1024;
/** A send may carry images, so its body cap is its own: five 8 MiB files as base64, plus room. */
const MAXIMUM_SEND_BYTES = 48 * 1024 * 1024;
const LIVE_STREAM_LAG_LIMIT = 32;

type LiveBackend = AgentBackend & { sessionUsage(sessionId: string): TokenUsage | null };

export function createAgentRoutes(resolveBackend: (id: string) => AgentBackend | undefined): RouteHandler {
  return (request, url, server) => {
    if (request.method === "POST" && url.pathname === CREATE_ROUTE) {
      return createSession(request, resolveBackend);
    }
    const message = MESSAGE_ROUTE.exec(url.pathname);
    if (request.method === "POST" && message) {
      return sendMessage(request, resolveBackend, message[1]!, message[2]!);
    }
    const abort = ABORT_ROUTE.exec(url.pathname);
    if (request.method === "POST" && abort) {
      return abortSession(request, resolveBackend, abort[1]!, abort[2]!);
    }
    const uiStream = UI_STREAM_ROUTE.exec(url.pathname);
    if (request.method === "GET" && uiStream) {
      return streamUi(request, server, resolveBackend, uiStream[1]!, uiStream[2]!);
    }
    const uiResponse = UI_RESPONSE_ROUTE.exec(url.pathname);
    if (request.method === "POST" && uiResponse) {
      return respondToUi(request, resolveBackend, uiResponse[1]!, uiResponse[2]!, uiResponse[3]!);
    }
    const events = EVENT_ROUTE.exec(url.pathname);
    if (request.method === "GET" && events && events[1] === "pi") {
      return pageEvents(url, resolveBackend, events[1], events[2]!);
    }
    const stream = STREAM_ROUTE.exec(url.pathname);
    if (request.method === "GET" && stream && stream[1] === "pi") {
      return streamEvents(request, url, server, resolveBackend, stream[1], stream[2]!);
    }
    const liveEvents = LIVE_EVENT_ROUTE.exec(url.pathname);
    if (request.method === "GET" && liveEvents) {
      return pageLiveEvents(url, resolveBackend, liveEvents[1]!, liveEvents[2]!);
    }
    const liveStream = LIVE_STREAM_ROUTE.exec(url.pathname);
    if (request.method === "GET" && liveStream) {
      return streamLiveEvents(request, url, server, resolveBackend, liveStream[1]!, liveStream[2]!);
    }
    return undefined;
  };
}

function streamUi(
  request: Request,
  server: Parameters<RouteHandler>[2],
  resolveBackend: (id: string) => AgentBackend | undefined,
  source: string,
  sessionId: string,
): Response {
  const backend = resolveBackend(source);
  if (!backend) return errorResponse("unknown-source", `agent source "${source}" is not registered`, 404);
  return startServerSentEventStream(request, server, (write) => {
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    void backend.subscribeUi(sessionId, (event) => write(encodeServerSentEvent(event)))
      .then((value) => {
        if (closed) value();
        else unsubscribe = value;
      })
      .catch((error) => write(encodeServerSentEvent({ error: errorPayload(error) })));
    return () => {
      closed = true;
      unsubscribe?.();
    };
  });
}

async function respondToUi(
  request: Request,
  resolveBackend: (id: string) => AgentBackend | undefined,
  source: string,
  sessionId: string,
  requestId: string,
): Promise<Response> {
  try {
    const backend = resolveBackend(source);
    if (!backend) return errorResponse("unknown-source", `agent source "${source}" is not registered`, 404, requestId);
    const body = await jsonBody(request);
    if (!("value" in body)) return errorResponse("invalid-request", "value is required", 400, requestId);
    const result = await backend.respondToUi(sessionId, requestId, body.value);
    if (result === "not-found") {
      return errorResponse("ui-request-not-found", "extension UI request is no longer pending", 404, requestId);
    }
    if (result === "invalid") {
      return errorResponse("invalid-ui-response", "value is not valid for this extension UI request", 422, requestId);
    }
    return jsonResponse({
      requestId,
      delivery: result === "already-resolved" ? "ui-already-resolved" : "ui",
    }, 202);
  } catch (error) {
    return routeError(error);
  }
}

async function createSession(request: Request, resolveBackend: (id: string) => AgentBackend | undefined): Promise<Response> {
  try {
    const body = await jsonBody(request);
    const requestId = requestIdentifier(body.requestId);
    const source = sourceIdentifier(body.source);
    const requestedProject = stringValue(body.projectPath);
    if (!requestId || !source || !requestedProject) return errorResponse("invalid-request", "requestId, source and projectPath are required", 400);
    const backend = resolveBackend(source);
    if (!backend) return errorResponse("unknown-source", `agent source "${source}" is not registered`, 404, requestId);
    const projectPath = await canonicalProjectPath(requestedProject);
    // The catalog, or any directory under home: the same answer a Bot gets when it binds one, so
    // a Bot whose directory has no sessions yet can still have its first one be an opencode one.
    const inCatalog = (path: string) => getSnapshot().some((session) => session.project === path);
    if (!projectPath || projectPath !== requestedProject || !bindableDirectory(projectPath, inCatalog)) {
      return errorResponse("project-not-found", "projectPath is not a directory this machine can start a session in", 404, requestId);
    }
    return jsonResponse(await backend.createSession(requestId, projectPath), 201);
  } catch (error) {
    return routeError(error);
  }
}

async function sendMessage(
  request: Request,
  resolveBackend: (id: string) => AgentBackend | undefined,
  source: string,
  sessionId: string,
): Promise<Response> {
  try {
    const backend = resolveBackend(source);
    if (!backend) return errorResponse("unknown-source", `agent source "${source}" is not registered`, 404);
    const body = await jsonBody(request, MAXIMUM_SEND_BYTES);
    const requestId = requestIdentifier(body.requestId);
    const text = typeof body.text === "string" ? body.text : "";
    const delivery = body.delivery;
    if (!requestId || !text.trim() || (delivery !== "next" && delivery !== "steer")) {
      return errorResponse("invalid-request", "requestId, nonempty text and delivery are required", 400, requestId ?? undefined);
    }
    if (new TextEncoder().encode(text).byteLength > MAXIMUM_BODY_BYTES) {
      return errorResponse("prompt-too-large", "prompt exceeds 256 KiB", 413, requestId);
    }
    let attachments;
    try {
      attachments = parseMessageAttachments(body.files);
    } catch (error) {
      return errorResponse("invalid-attachments", error instanceof Error ? error.message : String(error), 400, requestId);
    }
    if (attachments.length > 0 && source !== "opencode") {
      return errorResponse("unsupported-attachments", `agent source "${source}" takes no image attachments`, 400, requestId);
    }
    const receipt = await backend.send(sessionId, requestId, text, delivery as AgentMessageDelivery, attachments);
    return jsonResponse(receipt, 202);
  } catch (error) {
    return routeError(error);
  }
}

async function abortSession(
  request: Request,
  resolveBackend: (id: string) => AgentBackend | undefined,
  source: string,
  sessionId: string,
): Promise<Response> {
  try {
    const backend = resolveBackend(source);
    if (!backend) return errorResponse("unknown-source", `agent source "${source}" is not registered`, 404);
    const body = await jsonBody(request);
    const requestId = requestIdentifier(body.requestId);
    if (!requestId) return errorResponse("invalid-request", "requestId is required", 400);
    return jsonResponse(await backend.abort(sessionId, requestId), 202);
  } catch (error) {
    return routeError(error);
  }
}

async function pageLiveEvents(
  url: URL,
  resolveBackend: (id: string) => AgentBackend | undefined,
  source: string,
  sessionId: string,
): Promise<Response> {
  const backend = resolveBackend(source);
  if (!backend) return errorResponse("unknown-source", `agent source "${source}" is not registered`, 404);
  const mode = liveModeQuery(url);
  if (mode === null) return errorResponse("unsupported-mode", "live sessions support raw and nice only", 400);
  const at = eventsPageAtFromQuery(url.searchParams);
  const limit = integerQuery(url, "limit", 100, 500);
  if (at === null || limit === null || limit < 1) {
    return errorResponse("invalid-pagination", "invalid pagination", 400);
  }
  try {
    const page = await backendPage(backend, sessionId, at, limit, mode);
    const live = backend as LiveBackend;
    return jsonResponse({
      events: page.events,
      windowStart: page.windowStart,
      mode: page.mode,
      sequence: page.sequence,
      runState: page.runState,
      queue: page.queue,
      usage: typeof live.sessionUsage === "function" ? live.sessionUsage(sessionId) : null,
      ...(page.projectionId ? { projectionId: page.projectionId } : {}),
      ...stampSessionModel(backend, sessionId),
    });
  } catch (error) {
    return routeError(error);
  }
}

function liveModeQuery(url: URL): EventMode | null {
  const raw = url.searchParams.get("mode") ?? "nice";
  return raw === "nice" || raw === "raw" ? raw : null;
}

function streamLiveEvents(
  request: Request,
  url: URL,
  server: Parameters<RouteHandler>[2],
  resolveBackend: (id: string) => AgentBackend | undefined,
  source: string,
  sessionId: string,
): Response {
  const backend = resolveBackend(source);
  if (!backend) return errorResponse("unknown-source", `agent source "${source}" is not registered`, 404);
  const mode = liveModeQuery(url);
  if (mode === null) return errorResponse("unsupported-mode", "live sessions support raw and nice only", 400);
  const after = integerQuery(url, "since", 0, Number.MAX_SAFE_INTEGER);
  if (after === null) return errorResponse("invalid-sequence", "since must be a nonnegative integer", 400);
  const live = backend as LiveBackend;
  const usageFor = typeof live.sessionUsage === "function"
    ? (sid: string) => live.sessionUsage(sid)
    : () => null;
  return startServerSentEventStream(
    request,
    server,
    (write) => {
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      void backend.subscribe(sessionId, after, (envelope) => {
        write(encodeServerSentEvent({
          ...envelope,
          mode,
          events: envelope.events.map((event) => ({ ...event, otherModeIndex: event.index })),
          usage: usageFor(sessionId),
          ...stampSessionModel(backend, sessionId),
        }));
      })
        .then((value) => {
          if (closed) value();
          else unsubscribe = value;
        })
        .catch((error) => write(encodeServerSentEvent({ error: errorPayload(error) })));
      return () => {
        closed = true;
        unsubscribe?.();
      };
    },
    { lagLimit: LIVE_STREAM_LAG_LIMIT },
  );
}

async function pageEvents(
  url: URL,
  resolveBackend: (id: string) => AgentBackend | undefined,
  source: string,
  sessionId: string,
): Promise<Response> {
  try {
    const backend = resolveBackend(source);
    if (!backend) return errorResponse("unknown-source", `agent source "${source}" is not registered`, 404);
    const at = eventsPageAtFromQuery(url.searchParams);
    const limit = integerQuery(url, "limit", 100, 500);
    if (at === null || limit === null || limit < 1) return errorResponse("invalid-pagination", "invalid pagination", 400);
    if ((url.searchParams.get("mode") ?? "nice") !== "nice") return errorResponse("unsupported-mode", "Pi sessions support nice mode only", 400);
    const { total: _total, ...page } = await backendPage(backend, sessionId, at, limit, "nice");
    return jsonResponse(page);
  } catch (error) {
    return routeError(error);
  }
}

function streamEvents(
  request: Request,
  url: URL,
  server: Parameters<RouteHandler>[2],
  resolveBackend: (id: string) => AgentBackend | undefined,
  source: string,
  sessionId: string,
): Response {
  const backend = resolveBackend(source);
  if (!backend) return errorResponse("unknown-source", `agent source "${source}" is not registered`, 404);
  const after = integerQuery(url, "since", 0, Number.MAX_SAFE_INTEGER);
  if (after === null) return errorResponse("invalid-sequence", "since must be a nonnegative integer", 400);
  return startServerSentEventStream(request, server, (write) => {
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    void backend.subscribe(sessionId, after, (envelope) => write(encodeServerSentEvent(envelope)))
      .then((value) => {
        if (closed) value();
        else unsubscribe = value;
      })
      .catch((error) => write(encodeServerSentEvent({ error: errorPayload(error) })));
    return () => {
      closed = true;
      unsubscribe?.();
    };
  });
}

/** The request-reading and error-shaping helpers, shared with the opencode routes beside this. */
export async function jsonBody(request: Request, maximumBytes = MAXIMUM_BODY_BYTES): Promise<Record<string, unknown>> {
  const announced = Number(request.headers.get("content-length") ?? 0);
  if (announced > maximumBytes) throw new BodyTooLargeError();
  const bytes = await request.bytes();
  if (bytes.byteLength > maximumBytes) throw new BodyTooLargeError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new InvalidJsonError(error);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new InvalidJsonError();
  return parsed as Record<string, unknown>;
}

/** `before`, absent for the newest page; undefined when it is present and not a position. */
function integerQuery(url: URL, name: string, fallback: number, maximum: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? Math.min(value, maximum) : null;
}

export function requestIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

export function sourceIdentifier(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {
  constructor(options?: unknown) { super("request body is not valid JSON", { cause: options }); }
}

/** Also serves the opencode routes beside it, which shape their failures the same way. */
export function routeError(error: unknown): Response {
  if (error instanceof BodyTooLargeError) return errorResponse("body-too-large", "request body exceeds 256 KiB", 413);
  if (error instanceof InvalidJsonError) return errorResponse("invalid-json", error.message, 400);
  if (error instanceof AgentCommandConflictError) return errorResponse("request-conflict", error.message, 409);
  if (error instanceof AgentSessionNotFoundError) return errorResponse("session-not-found", error.message, 404);
  if (error instanceof AgentModeUnsupportedError) return errorResponse("unsupported-mode", error.message, 400);
  console.error("agent command route failed", error);
  return errorResponse("agent-command-failed", error instanceof Error ? error.message : String(error), 500, undefined, true);
}

function errorPayload(error: unknown) {
  return {
    code: error instanceof AgentSessionNotFoundError ? "session-not-found" : "agent-stream-failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: !(error instanceof AgentSessionNotFoundError),
  };
}

export function errorResponse(code: string, message: string, status: number, requestId?: string, retryable = false): Response {
  return jsonResponse({ error: { code, message, requestId, retryable } }, status);
}
