import {
  buildProjectDigests,
  parseDigestOptions,
  parseProjectDigestOptions,
  type PrimaryKind,
} from "../transcripts/projectDigest.ts";
import { getSnapshot } from "../transcripts/transcriptWatcher.ts";
import type { ProjectDigest } from "../transcripts/sources/transcriptTypes.ts";
import { jsonResponse } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

const DEFAULT_PROJECT_LIMIT = 20;
const MAXIMUM_PROJECT_LIMIT = 100;

async function projectDigestResponse(url: URL): Promise<Response> {
  const now = Date.now();
  let sessions = getSnapshot();
  const sourceParameter = url.searchParams.get("source");
  if (sourceParameter !== null) {
    const sources = new Set(
      sourceParameter.split(",").map((source) => source.trim()).filter(Boolean),
    );
    if (sources.size > 0) {
      sessions = sessions.filter((session) => sources.has(session.source));
    }
  }
  const projectParameter = url.searchParams.get("project");
  if (projectParameter !== null && projectParameter.length > 0) {
    sessions = sessions.filter((session) => session.project === projectParameter);
  }

  const primaryKind: PrimaryKind =
    url.searchParams.get("primaryKind") === "any" ? "any" : "work";
  const projects = await buildProjectDigests(
    sessions,
    parseDigestOptions(url),
    primaryKind,
    now,
    parseProjectDigestOptions(url),
  );

  const requestedLimit = Number(url.searchParams.get("limit") ?? DEFAULT_PROJECT_LIMIT);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.trunc(requestedLimit), MAXIMUM_PROJECT_LIMIT)
    : DEFAULT_PROJECT_LIMIT;
  const responseProjects: ProjectDigest[] = projects.slice(0, limit);
  return jsonResponse({
    projects: responseProjects,
    meta: {
      totalProjectsAvailable: projects.length,
      returnedProjects: responseProjects.length,
      truncated: responseProjects.length < projects.length,
      applied: {
        ...parseDigestOptions(url),
        ...parseProjectDigestOptions(url),
        primaryKind,
      },
    },
  });
}

export const handleProjectRoutes: RouteHandler = (request, url) => {
  if (request.method === "GET" && url.pathname === "/api/projects/digest") {
    return projectDigestResponse(url);
  }
  return undefined;
};
