import type {
  AgentSessionTerminalContext,
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentTerminalStreamEnvelope,
  AgentTerminalViewport,
} from "@agentdesk/agent-feed-wire";
import {
  AgentTerminalConflictError,
  AgentTerminalInvalidError,
  AgentTerminalNotFoundError,
  AgentTerminalUnavailableError,
} from "@/terminal/agentTerminalService";
import { encodeServerSentEvent, jsonResponse, startServerSentEventStream } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";

const TERMINALS_ROUTE = "/api/terminals";
/** Every open terminal on one stream; see `AgentTerminalStreamEnvelope` for why it is not one each. */
const TERMINALS_STREAM_ROUTE = "/api/terminals/stream";
const TERMINAL_ROUTE_PATTERN =
  /^\/api\/terminals\/([0-9a-f-]+)\/(input|viewport|close|checkpoint|history)$/;
/** Enough to cover a generous tmux history without letting one request become a memory decision. */
const MAXIMUM_HISTORY_LINES = 50_000;
const MAXIMUM_BODY_BYTES = 256 * 1024;

export interface AgentTerminalRoutesService {
  open(
    context: AgentTerminalContext,
    dimensions: { columns: number; rows: number },
  ): Promise<AgentTerminalDescriptor>;
  observe(listener: (envelope: AgentTerminalStreamEnvelope) => void): () => void;
  requestCheckpoint(terminalId: string): void;
  history(terminalId: string, lines: number): Promise<string>;
  sendInput(terminalId: string, data: string, encoding: "utf8" | "base64"): void;
  updateViewport(terminalId: string, viewport: AgentTerminalViewport): void;
  close(terminalId: string, mode: "detach" | "kill"): void;
}

export function createAgentTerminalRoutes(service: AgentTerminalRoutesService): RouteHandler {
  return (request, url, server) => {
    if (request.method === "POST" && url.pathname === TERMINALS_ROUTE) {
      return openTerminal(request, service);
    }
    // Before the id pattern, because "stream" is not a terminal id and must not be read as one.
    if (request.method === "GET" && url.pathname === TERMINALS_STREAM_ROUTE) {
      return startServerSentEventStream(request, server, (write) =>
        service.observe((envelope) => write(encodeServerSentEvent(envelope))));
    }
    const match = TERMINAL_ROUTE_PATTERN.exec(url.pathname);
    if (!match) return undefined;
    const terminalId = match[1]!;
    const operation = match[2]!;
    if (request.method === "GET" && operation === "history") {
      return terminalHistory(url, terminalId, service);
    }
    if (request.method !== "POST") return undefined;
    if (operation === "input") return terminalInput(request, terminalId, service);
    if (operation === "viewport") return terminalViewport(request, terminalId, service);
    if (operation === "close") return closeTerminal(request, terminalId, service);
    if (operation === "checkpoint") return terminalCheckpoint(terminalId, service);
    return undefined;
  };
}

async function openTerminal(
  request: Request,
  service: AgentTerminalRoutesService,
): Promise<Response> {
  try {
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    const descriptor = await service.open(terminalContext(objectValue(body.context, "context")), {
      columns: integerValue(body.columns, "columns"),
      rows: integerValue(body.rows, "rows"),
    });
    return jsonResponse(descriptor, 201);
  } catch (error) {
    return routeError(error);
  }
}

/** The kind is read first, because it decides which other fields have to be there. */
function terminalContext(context: Record<string, unknown>): AgentTerminalContext {
  const kind = stringValue(context.kind, "context.kind");
  if (kind === "tmux") {
    return { kind, session: stringValue(context.session, "context.session") };
  }
  // No project path: this kind names a session and lets the service resolve where it runs.
  if (kind === "session-tmux") {
    return {
      kind,
      source: stringValue(context.source, "context.source") as AgentSessionTerminalContext["source"],
      sessionId: stringValue(context.sessionId, "context.sessionId"),
    };
  }
  // A shell in a directory rather than anything to do with an agent. The path is read here and
  // vouched for by the service, which is where every other directory this route accepts is
  // checked against the user's home.
  if (kind === "workspace") {
    return { kind, workspacePath: stringValue(context.workspacePath, "context.workspacePath") };
  }
  // Nothing below creates anything. The two contexts that did -- a fork and a fresh session --
  // moved to the Bot that owns the directory they run in, so this resource is an attachment
  // capability again and asking for one twice is the same as asking once.
  if (kind !== "agent-session") {
    throw new AgentTerminalInvalidError(
      "context.kind must be agent-session, tmux, session-tmux or workspace",
    );
  }
  return {
    kind,
    projectPath: stringValue(context.projectPath, "context.projectPath"),
    source: stringValue(context.source, "context.source") as AgentSessionTerminalContext["source"],
    sessionId: stringValue(context.sessionId, "context.sessionId"),
  };
}

async function terminalInput(
  request: Request,
  terminalId: string,
  service: AgentTerminalRoutesService,
): Promise<Response> {
  try {
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    const encoding = stringValue(body.encoding, "encoding");
    if (encoding !== "utf8" && encoding !== "base64") {
      throw new AgentTerminalInvalidError("encoding must be utf8 or base64");
    }
    service.sendInput(terminalId, stringValue(body.data, "data"), encoding);
    return new Response(null, { status: 204 });
  } catch (error) {
    return routeError(error);
  }
}

async function terminalViewport(
  request: Request,
  terminalId: string,
  service: AgentTerminalRoutesService,
): Promise<Response> {
  try {
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    service.updateViewport(terminalId, {
      sequence: stringValue(body.sequence, "sequence"),
      active: booleanValue(body.active, "active"),
      claim: booleanValue(body.claim, "claim"),
      columns: integerValue(body.columns, "columns"),
      rows: integerValue(body.rows, "rows"),
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    return routeError(error);
  }
}

/**
 * The scrollback the viewer was never sent, base64 because it carries the escapes that colour it.
 *
 * Empty for a terminal with no history behind it, which is not an error: a resumed CLI's screen
 * comes from the PTY manager's own replay instead.
 */
async function terminalHistory(
  url: URL,
  terminalId: string,
  service: AgentTerminalRoutesService,
): Promise<Response> {
  try {
    const requested = Number(url.searchParams.get("lines") ?? MAXIMUM_HISTORY_LINES);
    if (!Number.isInteger(requested) || requested < 1 || requested > MAXIMUM_HISTORY_LINES) {
      throw new AgentTerminalInvalidError(`lines must be an integer between 1 and ${MAXIMUM_HISTORY_LINES}`);
    }
    const history = await service.history(terminalId, requested);
    return jsonResponse({ data: Buffer.from(history, "utf8").toString("base64") });
  } catch (error) {
    return routeError(error);
  }
}

/** No body: the request is the whole message, and a replay is the same ask every time. */
function terminalCheckpoint(
  terminalId: string,
  service: AgentTerminalRoutesService,
): Response {
  try {
    service.requestCheckpoint(terminalId);
    return new Response(null, { status: 204 });
  } catch (error) {
    return routeError(error);
  }
}

async function closeTerminal(
  request: Request,
  terminalId: string,
  service: AgentTerminalRoutesService,
): Promise<Response> {
  try {
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    const mode = stringValue(body.mode, "mode");
    if (mode !== "detach" && mode !== "kill") {
      throw new AgentTerminalInvalidError("mode must be detach or kill");
    }
    service.close(terminalId, mode);
    return new Response(null, { status: 204 });
  } catch (error) {
    return routeError(error);
  }
}

async function requestObject(request: Request): Promise<Record<string, unknown> | Response> {
  const announced = Number(request.headers.get("content-length") ?? 0);
  if (announced > MAXIMUM_BODY_BYTES) {
    return errorResponse("body-too-large", "request body exceeds 256 KiB", 413);
  }
  const bytes = await request.bytes();
  if (bytes.byteLength > MAXIMUM_BODY_BYTES) {
    return errorResponse("body-too-large", "request body exceeds 256 KiB", 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return errorResponse("invalid-json", "request body is not valid JSON", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse("invalid-request", "request body must be an object", 400);
  }
  return body as Record<string, unknown>;
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentTerminalInvalidError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AgentTerminalInvalidError(`${name} must be a non-empty string`);
  }
  return value;
}

function integerValue(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000) {
    throw new AgentTerminalInvalidError(`${name} must be an integer between 1 and 1000`);
  }
  return value as number;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new AgentTerminalInvalidError(`${name} must be a boolean`);
  return value;
}

function routeError(error: unknown): Response {
  if (error instanceof AgentTerminalInvalidError) return errorResponse("invalid-terminal", error.message, 400);
  if (error instanceof AgentTerminalNotFoundError) return errorResponse("terminal-not-found", error.message, 404);
  if (error instanceof AgentTerminalConflictError) return errorResponse("terminal-conflict", error.message, 409);
  if (error instanceof AgentTerminalUnavailableError) return errorResponse("pty-manager-unavailable", error.message, 503);
  console.error("Agent terminal route failed", error);
  return errorResponse("terminal-failed", error instanceof Error ? error.message : String(error), 500);
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message, retryable: status >= 500 } }, status);
}
