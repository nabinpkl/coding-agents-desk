import {
  getSnapshot,
  getWatcherState,
  projectSummaries,
  subscribeCatalog,
} from "../transcripts/transcriptCatalog.ts";
import {
  encodeServerSentEvent,
  jsonResponse,
  startServerSentEventStream,
} from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

function projectsPayload() {
  return { projects: projectSummaries(getSnapshot()) };
}

export const handleProjectRoutes: RouteHandler = (request, url, server) => {
  if (request.method !== "GET") return undefined;
  if (url.pathname !== "/api/projects" && url.pathname !== "/api/projects/stream") {
    return undefined;
  }
  if (getWatcherState() !== "live") {
    return jsonResponse({ error: "inventory-not-ready" }, 503);
  }
  if (url.pathname === "/api/projects") return jsonResponse(projectsPayload());
  return startServerSentEventStream(request, server, (write) => {
    write(encodeServerSentEvent(projectsPayload()));
    return subscribeCatalog((sessions) => {
      write(encodeServerSentEvent({ projects: projectSummaries(sessions) }));
    });
  });
};
