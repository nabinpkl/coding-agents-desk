import {
  ComposerError,
  composerCoordinator,
  type QuestionAction,
  type SessionKey,
  type WindowSource,
} from "../desktop/composerCoordinator.ts";
import { ControlHelperError, controlHelper } from "../desktop/controlHelper.ts";
import { encodeServerSentEvent, jsonResponse, startServerSentEventStream } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

/**
 * Claude Desktop's composer and AskUserQuestion panel, over HTTP.
 *
 * These used to be typed frames on the host's native lane, on the argument that writing into another
 * application through Accessibility is a capability and "changing one should cost a Swift compile
 * precisely because of what it can do". That argument was already inconsistent with the codebase:
 * ADR-0109 put `CGEvent` POSTING -- strictly more powerful than filling a text field -- behind
 * exactly this sidecar-plus-helper split. The capability bound did not disappear, it moved: the
 * sidecar resolves and validates, and the standalone helper is the only thing holding `AXUIElement`.
 * What went away is a Release host build and a re-attach of every surface for a change to a poll
 * interval.
 *
 * POST for every command and GET for the stream: `AgentFeedRelay.PathPolicy` is the panel's only
 * route to this sidecar inside the WKWebView and it admits those two verbs alone. That allow-list is
 * what keeps the relay from being an open local proxy, so it is worth spelling a verb around rather
 * than widening.
 */

const AUDIT_ROUTE = "/api/window/audit";
const CAPABILITIES_ROUTE = "/api/window/capabilities";
const COMPOSER_STREAM_ROUTE = "/api/window/composer/stream";
const COMPOSER_SYNC_ROUTE = "/api/window/composer/sync";
const COMPOSER_READ_ROUTE = "/api/window/composer/read";
const COMPOSER_SUBMIT_ROUTE = "/api/window/composer/submit";
const COMPOSER_CENSUS_ROUTE = "/api/window/composer/census";
const QUESTION_ACTION_ROUTE = "/api/window/question/action";

/** A composer holds a whole prompt, so this is generous; it is still a bound. */
const MAXIMUM_BODY_BYTES = 1024 * 1024;

export function createWindowRoutes(): RouteHandler {
  return (request, url, server) => {
    if (request.method === "GET") {
      if (url.pathname === AUDIT_ROUTE) return audit();
      if (url.pathname === CAPABILITIES_ROUTE) return capabilities();
      if (url.pathname === COMPOSER_STREAM_ROUTE) return composerStream(request, url, server);
      return undefined;
    }
    if (request.method !== "POST") return undefined;
    if (url.pathname === COMPOSER_SYNC_ROUTE) return composerText(request, "sync");
    if (url.pathname === COMPOSER_SUBMIT_ROUTE) return composerText(request, "submit");
    if (url.pathname === COMPOSER_READ_ROUTE) return composerRead(request);
    if (url.pathname === COMPOSER_CENSUS_ROUTE) return composerCensus(request);
    if (url.pathname === QUESTION_ACTION_ROUTE) return questionAction(request);
    return undefined;
  };
}

async function audit(): Promise<Response> {
  try {
    return jsonResponse(await controlHelper.request("desktop-audit"));
  } catch (error) {
    return failure(error);
  }
}

async function capabilities(): Promise<Response> {
  try {
    return jsonResponse(await controlHelper.capabilities());
  } catch (error) {
    return failure(error);
  }
}

/**
 * One session's composer and question state, as they change.
 *
 * One stream carrying both, because they share one poll pass: the question mirror rides the
 * composer's timer, and splitting them would double the Accessibility traffic for a window that is
 * walked once either way.
 */
function composerStream(request: Request, url: URL, server: Parameters<RouteHandler>[2]): Response {
  const sessionId = url.searchParams.get("sessionId");
  const source = windowSource(url.searchParams.get("source"));
  if (!sessionId || !source) return badRequest("sessionId and a known source are required");
  return startServerSentEventStream(request, server, (write) =>
    composerCoordinator.watch({ source, sessionId }, (envelope) =>
      write(encodeServerSentEvent(envelope))));
}

/**
 * The application whose window shows a session.
 *
 * Required rather than defaulted. The two resolvers ask different questions of the machine, and a
 * silently wrong default would run Claude's process-tree resolution against a Codex thread and
 * report "not running" for a window sitting in front of the user.
 */
function windowSource(raw: string | null): WindowSource | null {
  return raw === "claude" || raw === "codex" ? raw : null;
}

/** The session a command names, or null when either half is missing or unknown. */
function sessionKey(body: Record<string, unknown> | null): SessionKey | null {
  if (!body || typeof body.sessionId !== "string" || body.sessionId.length === 0) return null;
  const source = windowSource(typeof body.source === "string" ? body.source : null);
  return source ? { source, sessionId: body.sessionId } : null;
}

async function composerText(request: Request, kind: "sync" | "submit"): Promise<Response> {
  const body = await readJson(request);
  const key = sessionKey(body);
  const text = typeof body?.text === "string" ? body.text : null;
  if (!key || text === null) return badRequest("sessionId, source, and text are required");
  try {
    const written = kind === "sync"
      ? await composerCoordinator.sync(key, text)
      : await composerCoordinator.submit(key, text);
    return jsonResponse({ text: written });
  } catch (error) {
    return failure(error);
  }
}

async function composerRead(request: Request): Promise<Response> {
  const key = sessionKey(await readJson(request));
  if (!key) return badRequest("sessionId and source are required");
  try {
    return jsonResponse({ text: await composerCoordinator.read(key) });
  } catch (error) {
    return failure(error);
  }
}

async function composerCensus(request: Request): Promise<Response> {
  const body = await readJson(request);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
  if (!sessionId) return badRequest("sessionId is required");
  try {
    return jsonResponse(await composerCoordinator.census(sessionId));
  } catch (error) {
    return failure(error);
  }
}

async function questionAction(request: Request): Promise<Response> {
  const body = await readJson(request);
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : null;
  const action = body ? decodeAction(body) : null;
  if (!sessionId || !action) return badRequest("sessionId and a valid action are required");
  try {
    return jsonResponse(await composerCoordinator.questionAction(sessionId, action));
  } catch (error) {
    return failure(error);
  }
}

/**
 * Validated per kind at the door.
 *
 * A select without an index or an other without text is refused here rather than sent on, because
 * the helper would have to invent a meaning for the missing field and the only honest invention is
 * to press something the viewer did not ask for.
 */
function decodeAction(body: Record<string, unknown>): QuestionAction | null {
  const kind = body.kind;
  if (kind === "select") {
    if (!Number.isInteger(body.option) || (body.option as number) < 0) return null;
    return { kind, option: body.option as number, desired: body.desired !== false };
  }
  if (kind === "other") {
    return typeof body.text === "string" ? { kind, text: body.text } : null;
  }
  if (kind === "submit" || kind === "skip" || kind === "dismiss" || kind === "view-options") {
    return { kind };
  }
  return null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const raw = await request.text();
  if (raw.length > MAXIMUM_BODY_BYTES) return null;
  try {
    const decoded = JSON.parse(raw) as unknown;
    return typeof decoded === "object" && decoded !== null ? decoded as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function badRequest(message: string): Response {
  return errorResponse("window-bad-request", message, 400);
}

/**
 * The envelope every sidecar failure uses: `{ error: { code, message } }`, not a bare `{code}`.
 * The panel's `parse` reads the nested form, and a top-level one would flatten to a generic
 * "sidecar answered 503" -- which would lose the very reason code this whole path exists to carry.
 */
function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message, retryable: status >= 500 } }, status);
}

/**
 * 503 with the reason code intact.
 *
 * Not 500: every failure here is a state the caller can act on -- open the session, close the second
 * instance, grant Accessibility, build the helper -- rather than a bug in this process. The panel
 * maps the code to a sentence, and a code it does not recognize degrades to "unavailable, reason
 * unknown" instead of showing a stack.
 */
function failure(error: unknown): Response {
  if (error instanceof ComposerError) {
    return errorResponse("window-composer-failed", error.reason, 503);
  }
  if (error instanceof ControlHelperError) {
    return errorResponse("window-helper-unavailable", error.reason, 503);
  }
  throw error;
}
