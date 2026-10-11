// `GET /api/workspaces/<id>/stream` -- everything about one workspace, as it changes.
//
// One stream rather than one per concern. The panel already opens an EventSource for the catalog,
// the transcript, background tasks, the summary, usage, bots, the session board and the terminals;
// a browser allows about six connections per origin under HTTP/1.1, and the stream that loses does
// so silently (AGENTS.md, "The dev origin serves HTTP/2"). Three IDE streams would be three more
// chances to be the one that loses.

import { encodeServerSentEvent, startServerSentEventStream } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import { workspaceErrorResponse, workspaceRoute } from "@/http/workspace-routes/workspaceResponses";
import type { WorkspaceService } from "@/workspace/workspaceService";

/**
 * How far behind a reader may fall before it is closed.
 *
 * A tree projection is the largest thing this stream sends, and a reader that has not drained a
 * dozen of them is not reading. Closing beats buffering: an `EventSource` reconnects and gets one
 * fresh projection, which is what it wanted anyway.
 */
const LAG_LIMIT = 16;

export function createWorkspaceStreamRoutes(service: WorkspaceService): RouteHandler {
  return (request, url, server) => {
    const route = workspaceRoute(url.pathname);
    if (!route || route.action !== "stream" || request.method !== "GET") return undefined;
    const { id } = route;
    if (!service.workspace(id)) {
      return workspaceErrorResponse("workspaceUnavailable", "Workspace is unavailable.", id);
    }

    return startServerSentEventStream(request, server, (write) => {
      // The current state before any change, so a reader that opens the stream is not blank until
      // something happens to the disk. This is the initial load and the live update in one place,
      // which is why the panel needs no separate fetch on mount.
      write(encodeServerSentEvent({ type: "workspaces", workspaces: service.store.list() }));
      write(encodeServerSentEvent({ type: "sharedState", state: service.sharedState.snapshot(id) }));
      void service.refreshGit(id).then((status) => {
        write(encodeServerSentEvent({ type: "git", status }));
        return service.tree(id);
      }).then((tree) => {
        write(encodeServerSentEvent({ type: "tree", workspaceId: id, tree }));
      }).catch((error: unknown) => {
        console.error("workspace stream bootstrap failed", error);
      });

      // Events for other workspaces are dropped here rather than filtered at the source, because
      // one service fans out to every reader and a reader asked about one workspace.
      return service.subscribe((event) => {
        if ("workspaceId" in event && event.workspaceId !== id) return;
        if (event.type === "git" && event.status.workspaceId !== id) return;
        if (event.type === "sharedState" && event.state.workspaceId !== id) return;
        write(encodeServerSentEvent(event));
      });
    }, { lagLimit: LAG_LIMIT });
  };
}
