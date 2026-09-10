// Turning a refusal from the workspace layer into an HTTP answer, in one place.
//
// One place because the mapping is the contract: the panel renders `code`, and a route that
// invented its own status or its own spelling would make one refusal look like two.

import type { WorkspaceError, WorkspaceErrorCode } from "@agentdesk/agent-feed-wire";
import { jsonResponse } from "@/http/httpResponses";
import { SharedStateFailure } from "@/workspace/workspaceSharedState";
import { WorkspaceFailure } from "@/workspace/workspacePaths";
import { WorkspaceStoreError } from "@/workspace/workspaceStore";

/**
 * The status each refusal travels as.
 *
 * `notFound` is 404 and everything else a client got wrong is 400, with two deliberate exceptions:
 * `forbidden` is 403 because a symlink escape is a refusal rather than a malformed request, and
 * `revisionConflict` is 409 because the client was not wrong at all, it was merely behind.
 */
const STATUS: Record<WorkspaceErrorCode, number> = {
  workspaceUnavailable: 404,
  invalidPath: 400,
  notFound: 404,
  forbidden: 403,
  notDirectory: 400,
  notFile: 400,
  readOnly: 409,
  binary: 415,
  invalidUtf8: 415,
  tooLarge: 413,
  writeFailed: 500,
  revisionConflict: 409,
  invalidOperation: 400,
  stateLimitExceeded: 429,
  internal: 500,
};

export function workspaceErrorResponse(
  code: WorkspaceErrorCode,
  message: string,
  workspaceId: string | null = null,
  path: string | null = null,
): Response {
  const error: WorkspaceError = { code, message, workspaceId, path };
  return jsonResponse({ error }, STATUS[code]);
}

/**
 * Map anything thrown below the route layer onto the wire's error codes.
 *
 * An unrecognised throw becomes a 500 rather than being reshaped into a client error: the sidecar
 * getting something wrong and the client getting something wrong are different facts, and blurring
 * them is how a bug here reads as a bad request for a week.
 */
export function refusalResponse(
  error: unknown,
  workspaceId: string | null = null,
  path: string | null = null,
): Response {
  if (error instanceof WorkspaceFailure) {
    return workspaceErrorResponse(error.code, error.message, workspaceId, path);
  }
  if (error instanceof SharedStateFailure) {
    return workspaceErrorResponse(error.code, error.message, workspaceId, path);
  }
  if (error instanceof RequestFailure) {
    return workspaceErrorResponse(error.code, error.message, workspaceId, path);
  }
  if (error instanceof WorkspaceStoreError) {
    return workspaceErrorResponse("invalidOperation", error.message, workspaceId, path);
  }
  console.error("workspace request failed", error);
  return workspaceErrorResponse("internal", "The request could not be completed.", workspaceId, path);
}

/**
 * The workspace id and trailing action in `/api/workspace/<id>/<action>`, or null.
 *
 * Returns null rather than throwing for a path this module does not own, because a route handler
 * that does not match must fall through to the next one.
 */
export function workspaceRoute(pathname: string): { id: string; action: string } | null {
  const parts = pathname.split("/");
  // ["", "api", "workspace", id, action]
  if (parts.length !== 5 || parts[1] !== "api" || parts[2] !== "workspace") return null;
  const id = decodeURIComponent(parts[3] ?? "");
  const action = parts[4] ?? "";
  if (id === "" || action === "") return null;
  return { id, action };
}

/** A refusal raised by a route itself, for a request that never reached the workspace layer. */
export class RequestFailure extends Error {
  constructor(readonly code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = "RequestFailure";
  }
}

/** Read a JSON object body, or refuse anything that is not one. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new RequestFailure("invalidOperation", "The request body is not JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RequestFailure("invalidOperation", "The request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

/** A required string field, or a refusal naming it. */
export function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value === "") {
    throw new RequestFailure("invalidOperation", `"${field}" is required.`);
  }
  return value;
}
