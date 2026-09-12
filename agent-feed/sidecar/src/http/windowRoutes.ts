import {
  ComposerError,
  composerCoordinator,
  type QuestionAction,
  type SessionKey,
  type WindowSource,
} from "@/desktop/composerCoordinator";
import { unlink } from "node:fs/promises";

import { ControlHelperError, controlHelper } from "@/desktop/controlHelper";
import { encodeServerSentEvent, jsonResponse, startServerSentEventStream } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";

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
const INPUT_ROUTE = "/api/window/input";
const SHOT_ROUTE = "/api/window/shot";

/** Commands one request may aim at a window. Mirrors the helper's own bound. */
const MAXIMUM_INPUT_COMMANDS = 64;

/** A composer holds a whole prompt, so this is generous; it is still a bound. */
const MAXIMUM_BODY_BYTES = 1024 * 1024;

export function createWindowRoutes(): RouteHandler {
  return (request, url, server) => {
    if (request.method === "GET") {
      if (url.pathname === AUDIT_ROUTE) return audit();
      if (url.pathname === CAPABILITIES_ROUTE) return capabilities();
      if (url.pathname === SHOT_ROUTE) return windowShot(url);
      if (url.pathname === COMPOSER_STREAM_ROUTE) return composerStream(request, url, server);
      return undefined;
    }
    if (request.method !== "POST") return undefined;
    if (url.pathname === COMPOSER_SYNC_ROUTE) return composerText(request, "sync");
    if (url.pathname === COMPOSER_SUBMIT_ROUTE) return composerText(request, "submit");
    if (url.pathname === COMPOSER_READ_ROUTE) return composerRead(request);
    if (url.pathname === COMPOSER_CENSUS_ROUTE) return composerCensus(request);
    if (url.pathname === QUESTION_ACTION_ROUTE) return questionAction(request);
    if (url.pathname === INPUT_ROUTE) return windowInput(request);
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

/**
 * Aim desktop-control commands at one window rather than at whatever holds focus.
 *
 * The helper raises the window first, which is the part that needs saying out loud: everywhere else
 * in this file is deliberately non-obtrusive, because the console user is working and a window that
 * jumps forward is a stolen keystroke. This is for the agent's own login session, which has its own
 * pointer, focus and frontmost application, and calling it against a session someone is using would
 * be exactly the rudeness the rest of the path avoids.
 *
 * The commands are passed through rather than re-validated here. They are the same desktop-control
 * vocabulary the WebRTC lane carries, and the helper hands them to the same parser with the same
 * bounds clamping, so a second validator in this file would be a second place for it to drift.
 */
/**
 * A PNG of one window, by id.
 *
 * The helper writes the file and reports its path; this reads the bytes and deletes it, so a
 * caller gets an image and the temporary directory does not fill up with every look taken. Both
 * processes are the same user, which is the only reason handing a path across is enough.
 *
 * A GET, like the other two reads here. It does reach into the window server, but it changes
 * nothing, and making it a POST would only mean the panel's relay had to spell it differently.
 */
async function windowShot(url: URL): Promise<Response> {
  const windowID = Number(url.searchParams.get("windowID"));
  if (!Number.isInteger(windowID) || windowID <= 0) {
    return badRequest("windowID must be a positive integer WindowServer id");
  }
  const raw = url.searchParams.get("maxWidth");
  const maxWidth = raw === null ? undefined : Number(raw);
  if (maxWidth !== undefined && (!Number.isInteger(maxWidth) || maxWidth <= 0)) {
    return badRequest("maxWidth must be a positive integer");
  }
  try {
    const result = await controlHelper.request("window-shot", { windowID, maxWidth });
    const path = typeof result.path === "string" ? result.path : null;
    if (!path) return errorResponse("window-shot-failed", "helper returned no image", 503);
    const file = Bun.file(path);
    const bytes = await file.arrayBuffer();
    await unlink(path).catch(() => {});
    return new Response(bytes, {
      headers: {
        "content-type": "image/png",
        "cache-control": "no-store",
        // The dimensions and the window's own identity, for a caller that took the picture to
        // find out what is in it rather than to look at it.
        "x-window-width": String(result.width ?? ""),
        "x-window-height": String(result.height ?? ""),
        "x-window-app": encodeURIComponent(String(result.app ?? "")),
        "x-window-title": encodeURIComponent(String(result.title ?? "")),
      },
    });
  } catch (error) {
    return failure(error);
  }
}

async function windowInput(request: Request): Promise<Response> {
  const body = await readJson(request);
  const windowID = body?.windowID;
  if (typeof windowID !== "number" || !Number.isInteger(windowID) || windowID <= 0) {
    return badRequest("windowID must be a positive integer WindowServer id");
  }
  const input = body?.input;
  if (!Array.isArray(input) || input.length === 0 || input.length > MAXIMUM_INPUT_COMMANDS) {
    return badRequest(`input must be 1 to ${MAXIMUM_INPUT_COMMANDS} desktop-control commands`);
  }
  if (input.some((command) => typeof command !== "object" || command === null)) {
    return badRequest("every input command must be an object");
  }
  try {
    return jsonResponse(await controlHelper.request("window-input", { windowID, input }));
  } catch (error) {
    return failure(error);
  }
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
