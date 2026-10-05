// Reading and writing one file.
//
// Separate from the roster routes because the trust boundary is different: everything here takes a
// path from an unauthenticated caller and turns it into a filesystem operation. Keeping them apart
// means the file routes can be read in one sitting by whoever is checking that boundary.

import type { WorkspaceFileRead } from "@agentdesk/agent-feed-wire";
import { jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";
import {
  readJsonBody,
  refusalResponse,
  RequestFailure,
  requiredString,
  workspaceErrorResponse,
  workspaceRoute,
} from "@/http/workspace-routes/workspaceResponses";
import {
  fileKind,
  isBinaryKind,
  readDocumentFile,
  readTextFile,
  type WorkspaceDocumentFile,
  writeTextFile,
} from "@/workspace/workspaceFiles";
import type { WorkspaceService } from "@/workspace/workspaceService";

export interface WorkspaceFileLimits {
  /** The largest file the editor will load as text. */
  maxTextBytes: number;
  /** The largest binary-backed document the panel will be handed. */
  maxDocumentBytes: number;
}

/**
 * Reading and writing one file.
 *
 * Synchronous matching, promise-returning answers, for the reason spelled out in
 * `workspaceRoutes.ts`: an `async` handler cannot decline a request.
 */
export function createWorkspaceFileRoutes(
  service: WorkspaceService,
  limits: WorkspaceFileLimits,
): RouteHandler {
  return (request, url) => {
    const route = workspaceRoute(url.pathname);
    if (!route) return undefined;
    const { id, action } = route;
    if (action !== "file" && action !== "content") return undefined;

    const workspace = service.workspace(id);
    if (!workspace) {
      return workspaceErrorResponse("workspaceUnavailable", "Workspace is unavailable.", id);
    }
    const path = url.searchParams.get("path") ?? "";

    if (action === "file" && request.method === "GET") {
      return readOne(workspace.root, id, path, limits);
    }
    if (action === "content" && request.method === "GET") {
      return readBytes(workspace.root, id, path, limits);
    }
    if (action === "file" && request.method === "POST") {
      return write(workspace.root, id, request, limits);
    }
    return undefined;
  };
}

/**
 * A file's text and its revision.
 *
 * A binary-backed kind answers with its metadata and no text; the bytes come from `content`.
 * Sending them base64 inside this JSON would double a document's size on the wire and put it in the
 * same response as the tab's title.
 */
async function readOne(
  root: string,
  id: string,
  path: string,
  limits: WorkspaceFileLimits,
): Promise<Response> {
  try {
    const kind = fileKind(path);
    const revision = isBinaryKind(kind)
      ? (await readDocumentFile(root, path, limits.maxDocumentBytes)).revision
      : null;
    if (revision !== null) {
      const file: WorkspaceFileRead = { workspaceId: id, path, kind, revision, text: null };
      return jsonResponse({ file });
    }
    const text = await readTextFile(root, path, limits.maxTextBytes);
    const file: WorkspaceFileRead = {
      workspaceId: id,
      path,
      kind,
      revision: text.revision,
      text: text.text,
    };
    return jsonResponse({ file });
  } catch (error) {
    return refusalResponse(error, id, path);
  }
}

async function readBytes(
  root: string,
  id: string,
  path: string,
  limits: WorkspaceFileLimits,
): Promise<Response> {
  try {
    return documentResponse(await readDocumentFile(root, path, limits.maxDocumentBytes));
  } catch (error) {
    return refusalResponse(error, id, path);
  }
}

/**
 * A file's bytes as the content routes answer them, the IDE's and a Bot's alike.
 *
 * `octet-stream` whatever the kind: the panel fetches these and hands them to its own renderer, and
 * a type the browser would render itself is a document running on the panel's origin if someone
 * opens the address directly.
 */
export function documentResponse(document: WorkspaceDocumentFile): Response {
  return new Response(document.bytes, {
    headers: {
      "content-type": "application/octet-stream",
      // The revision is the sha256 of exactly these bytes, so it is already a strong ETag.
      etag: `"${document.revision}"`,
      "cache-control": "no-cache",
    },
  });
}

async function write(
  root: string,
  id: string,
  request: Request,
  limits: WorkspaceFileLimits,
): Promise<Response> {
  let path = "";
  try {
    const body = await readJsonBody(request);
    path = requiredString(body, "path");
    if (typeof body.text !== "string") {
      throw new RequestFailure("invalidOperation", '"text" is required.');
    }
    const outcome = await writeTextFile(
      root,
      path,
      requiredString(body, "expectedRevision"),
      body.text,
      limits.maxTextBytes,
    );
    if (outcome.status === "conflict") {
      return jsonResponse(
        { conflict: { workspaceId: id, path, currentRevision: outcome.currentRevision } },
        409,
      );
    }
    return jsonResponse({ written: { workspaceId: id, path, revision: outcome.revision } });
  } catch (error) {
    return refusalResponse(error, id, path);
  }
}
