// Reading committed history: the log, one commit's files, and one file's patch.
//
// Its own file rather than three more branches in the roster routes, for the reason the file routes
// are their own: these take a commit and a path from an unauthenticated caller and hand both to
// git. What is different from the file routes is that everything here is read-only by construction
// -- `workspaceHistory` runs `log` and `show` and nothing else -- so the boundary to check is
// argument injection rather than the filesystem.

import { jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";
import {
  refusalResponse,
  RequestFailure,
  workspaceErrorResponse,
  workspaceRoute,
} from "@/http/workspace-routes/workspaceResponses";
import { commitDetail, commitFileDiff, listCommits } from "@/workspace/workspaceHistory";
import type { WorkspaceService } from "@/workspace/workspaceService";

/**
 * How many commits a request that does not say gets.
 *
 * Enough to fill the popup several times over, so the commonest reading -- what landed today --
 * never needs a second request, and small enough that a repository with a hundred thousand commits
 * answers in the same time as this one.
 */
const DEFAULT_LIMIT = 50;

/**
 * The history routes.
 *
 * Synchronous matching, promise-returning answers, for the reason spelled out in
 * `workspaceRoutes.ts`: an `async` handler cannot decline a request.
 */
export function createWorkspaceHistoryRoutes(service: WorkspaceService): RouteHandler {
  return (request, url) => {
    const route = workspaceRoute(url.pathname);
    if (!route) return undefined;
    const { id, action } = route;
    if (action !== "commits" && action !== "commit" && action !== "diff") return undefined;
    if (request.method !== "GET") return undefined;

    const workspace = service.workspace(id);
    if (!workspace) {
      return workspaceErrorResponse("workspaceUnavailable", "Workspace is unavailable.", id);
    }
    const { root } = workspace;
    const parameters = url.searchParams;

    if (action === "commits") {
      const asked = parameters.get("limit");
      const limit = asked === null ? DEFAULT_LIMIT : Number.parseInt(asked, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        return refusalResponse(
          new RequestFailure("invalidOperation", '"limit" must be a positive integer.'),
          id,
        );
      }
      return listCommits(root, limit)
        .then((commits) => jsonResponse({ commits }))
        .catch((error: unknown) => refusalResponse(error, id));
    }

    const hash = parameters.get("hash") ?? "";
    if (action === "commit") {
      return commitDetail(root, id, hash)
        .then((detail) => jsonResponse({ detail }))
        .catch((error: unknown) => refusalResponse(error, id));
    }

    const path = parameters.get("path") ?? "";
    return commitFileDiff(root, id, hash, path)
      .then((diff) => jsonResponse({ diff }))
      .catch((error: unknown) => refusalResponse(error, id, path));
  };
}
