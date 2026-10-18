// The IDE's two searches: every file for quick open, and the lines that match for the Search
// section.
//
// Its own file for the reason the history routes are: both take text from an unauthenticated
// caller and hand it to a program. The boundary is `rg`'s argv, which `workspace/search/` builds
// as an argv; everything this file adds is reading the query string and answering refusals.

import type { WorkspaceSearchOptions } from "@agentdesk/agent-feed-wire";
import { jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import { refusalResponse, workspaceErrorResponse, workspaceRoute } from "@/http/workspace-routes/workspaceResponses";
import { searchContent } from "@/workspace/search/contentSearch";
import { listFiles } from "@/workspace/search/fileList";
import type { WorkspaceService } from "@/workspace/workspaceService";

/** A comma-separated glob list, as VS Code's include and exclude fields take one. */
function globs(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean);
}

export function parseSearchOptions(parameters: URLSearchParams): WorkspaceSearchOptions {
  const flag = (name: string) => parameters.get(name) === "1";
  return {
    matchCase: flag("case"),
    wholeWord: flag("word"),
    regex: flag("regex"),
    include: globs(parameters.get("include")),
    exclude: globs(parameters.get("exclude")),
  };
}

/**
 * The search routes.
 *
 * Each request's own `signal` is handed to `rg`: a reader who types past a search aborts its
 * request, and that is what kills the process rather than letting it finish for nobody.
 */
export function createWorkspaceSearchRoutes(service: WorkspaceService, ripgrepPath: string | null): RouteHandler {
  return (request, url) => {
    const route = workspaceRoute(url.pathname);
    if (!route || request.method !== "GET") return undefined;
    const { id, action } = route;
    if (action !== "files" && action !== "search") return undefined;

    const workspace = service.workspace(id);
    if (!workspace) {
      return workspaceErrorResponse("workspaceUnavailable", "Workspace is unavailable.", id);
    }

    if (action === "files") {
      return listFiles(ripgrepPath, workspace.root, request.signal)
        .then(({ files, truncated }) => jsonResponse({ workspaceId: id, files, truncated }))
        .catch((error: unknown) => refusalResponse(error, id));
    }

    const query = url.searchParams.get("q") ?? "";
    return searchContent(ripgrepPath, workspace.root, query, parseSearchOptions(url.searchParams), request.signal)
      .then((result) => jsonResponse({ workspaceId: id, query, ...result }))
      .catch((error: unknown) => refusalResponse(error, id));
  };
}
