// The opencode-only half of the agent-session surface: what a session offers after a slash,
// running one, the model list, the two reads that answer a question rather than change anything
// -- `/btw` and `/export` -- and the one write a dialog asks for rather than a composer, the
// session's title.
//
// Split out of `agentRoutes.ts` because that file had reached the 500-line cap and this is the
// half that had grown: the routes below are the only ones that speak opencode, and opencode is
// the only source with a slash-command surface at all. They are registered before it (see
// `server.ts`) so a path here is never read as a generic agent-session one.

import type { AgentBackend, AgentCommandReceipt } from "@/agents/agentBackend";
import { jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";
import { errorResponse, jsonBody, requestIdentifier, routeError, stringValue } from "@/http/agent-routes/agentRoutes";

const COMMANDS_ROUTE = "/api/agent-sessions/opencode/commands";
const MODELS_ROUTE = "/api/agent-sessions/opencode/models";
const MODEL_ROUTE = /^\/api\/agent-sessions\/opencode\/([A-Za-z0-9._:-]{1,128})\/model$/;
const RUN_ROUTE = /^\/api\/agent-sessions\/opencode\/([A-Za-z0-9._:-]{1,128})\/command$/;
const ASIDE_ROUTE = /^\/api\/agent-sessions\/opencode\/([A-Za-z0-9._:-]{1,128})\/aside$/;
const EXPORT_ROUTE = /^\/api\/agent-sessions\/opencode\/([A-Za-z0-9._:-]{1,128})\/export$/;
const TITLE_ROUTE = /^\/api\/agent-sessions\/opencode\/([A-Za-z0-9._:-]{1,128})\/title$/;
/** A command's arguments ride the same 256 KiB a send's text does. */
const MAXIMUM_BODY_BYTES = 256 * 1024;

export function createOpencodeRoutes(resolveBackend: (id: string) => AgentBackend | undefined): RouteHandler {
  return (request, url) => {
    if (request.method === "GET" && url.pathname === COMMANDS_ROUTE) {
      return listCommands(resolveBackend);
    }
    if (request.method === "GET" && url.pathname === MODELS_ROUTE) {
      return listModels(resolveBackend);
    }
    const run = RUN_ROUTE.exec(url.pathname);
    if (request.method === "POST" && run) {
      return runCommand(request, resolveBackend, run[1]!);
    }
    const model = MODEL_ROUTE.exec(url.pathname);
    if (request.method === "POST" && model) {
      return switchModel(request, resolveBackend, model[1]!);
    }
    const aside = ASIDE_ROUTE.exec(url.pathname);
    if (request.method === "POST" && aside) {
      return askAside(request, resolveBackend, aside[1]!);
    }
    const title = TITLE_ROUTE.exec(url.pathname);
    if (request.method === "POST" && title) {
      return renameTitle(request, resolveBackend, title[1]!);
    }
    const exported = EXPORT_ROUTE.exec(url.pathname);
    if (request.method === "GET" && exported) {
      return exportTranscript(resolveBackend, exported[1]!);
    }
    return undefined;
  };
}

/** The opencode-only backend surface these routes need; resolved by id, like the handover. */
export interface OpencodeRoutesBackend {
  listCommands(): Promise<Array<{ name: string; description?: string; aliases?: string[] }>>;
  runCommand(sessionId: string, requestId: string, name: string, text: string): Promise<AgentCommandReceipt>;
  listModels(): Promise<Array<{ providerID: string; modelID: string; name: string; contextLimit: number | null; inputCost: number | null; outputCost: number | null }>>;
  switchModel(sessionId: string, requestId: string, providerID: string, modelID: string): Promise<AgentCommandReceipt>;
  /** `/btw`: one answer from the session's own context, changing nothing. */
  askAside(sessionId: string, question: string): Promise<string>;
  /** `/export`: the projected transcript, whole, as the web client downloads it. */
  exportTranscript(sessionId: string): Promise<unknown>;
  /** The panel's Rename dialog: one title on one session, and no turn anywhere. */
  renameSession(sessionId: string, title: string): Promise<void>;
}

function opencodeBackend(
  resolveBackend: (id: string) => AgentBackend | undefined,
  requestId?: string,
): OpencodeRoutesBackend | Response {
  const backend = resolveBackend("opencode") as unknown as OpencodeRoutesBackend | undefined;
  if (!backend) return errorResponse("unknown-source", `agent source "opencode" is not registered`, 404, requestId);
  return backend;
}

async function listCommands(resolveBackend: (id: string) => AgentBackend | undefined): Promise<Response> {
  const backend = opencodeBackend(resolveBackend);
  if (backend instanceof Response) return backend;
  try {
    return jsonResponse({ commands: await backend.listCommands() });
  } catch (error) { return routeError(error); }
}

async function runCommand(request: Request, resolveBackend: (id: string) => AgentBackend | undefined, sessionId: string): Promise<Response> {
  try {
    const body = await jsonBody(request);
    const requestId = requestIdentifier(body.requestId);
    const backend = opencodeBackend(resolveBackend, requestId ?? undefined);
    if (backend instanceof Response) return backend;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (!requestId || !name) return errorResponse("invalid-request", "requestId and name are required", 400, requestId ?? undefined);
    if (new TextEncoder().encode(text).byteLength > MAXIMUM_BODY_BYTES) {
      return errorResponse("command-too-large", "command arguments exceed 256 KiB", 413, requestId);
    }
    return jsonResponse(await backend.runCommand(sessionId, requestId, name, text), 202);
  } catch (error) { return routeError(error); }
}

async function listModels(resolveBackend: (id: string) => AgentBackend | undefined): Promise<Response> {
  const backend = opencodeBackend(resolveBackend);
  if (backend instanceof Response) return backend;
  try {
    return jsonResponse({ models: await backend.listModels() });
  } catch (error) { return routeError(error); }
}

async function switchModel(request: Request, resolveBackend: (id: string) => AgentBackend | undefined, sessionId: string): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await jsonBody(request);
  } catch (error) {
    return routeError(error);
  }
  const requestId = requestIdentifier(body.requestId);
  const providerID = stringValue(body.providerID);
  const modelID = stringValue(body.modelID);
  if (!requestId || !providerID || !modelID) {
    return errorResponse("invalid-request", "requestId, providerID and modelID are required", 400, requestId ?? undefined);
  }
  const backend = opencodeBackend(resolveBackend, requestId);
  if (backend instanceof Response) return backend;
  try {
    return jsonResponse(await backend.switchModel(sessionId, requestId, providerID, modelID), 202);
  } catch (error) { return routeError(error); }
}

/**
 * Answers a question from the session's context without adding to the conversation, which is
 * what the TUI's `/btw` and the web client's are for. Its own route rather than the command
 * route because the answer is the payload: a receipt exists to be correlated with a turn, and
 * this one starts no turn.
 */
async function askAside(request: Request, resolveBackend: (id: string) => AgentBackend | undefined, sessionId: string): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await jsonBody(request);
  } catch (error) {
    return routeError(error);
  }
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return errorResponse("invalid-request", "question is required", 400);
  const backend = opencodeBackend(resolveBackend);
  if (backend instanceof Response) return backend;
  try {
    return jsonResponse({ text: await backend.askAside(sessionId, question) });
  } catch (error) { return routeError(error); }
}

/** The whole projected transcript, as the web client's `/export` writes it to a file. */
async function exportTranscript(resolveBackend: (id: string) => AgentBackend | undefined, sessionId: string): Promise<Response> {
  const backend = opencodeBackend(resolveBackend);
  if (backend instanceof Response) return backend;
  try {
    return jsonResponse({ transcript: await backend.exportTranscript(sessionId) });
  } catch (error) { return routeError(error); }
}

/**
 * The title a session now has, as the Rename dialog asks for it.
 *
 * Its own route rather than the command route's `/rename` for the reason the reads have one: this
 * changes a label and starts no turn, so there is no receipt to correlate and no turn to queue it
 * behind. The answer carries the title that was stored rather than the one that was typed, trimmed
 * the way it was sent, so a caller can show what it got without a second read.
 */
async function renameTitle(request: Request, resolveBackend: (id: string) => AgentBackend | undefined, sessionId: string): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await jsonBody(request);
  } catch (error) {
    return routeError(error);
  }
  // Trimmed here, so a blank title is a bad request rather than a serve that stores one: the
  // catalog falls back to the first prompt for an empty title, which reads as a rename that did
  // nothing.
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return errorResponse("invalid-title", "a session title is required", 400);
  const backend = opencodeBackend(resolveBackend);
  if (backend instanceof Response) return backend;
  try {
    await backend.renameSession(sessionId, title);
    return jsonResponse({ sessionId, title });
  } catch (error) { return routeError(error); }
}
