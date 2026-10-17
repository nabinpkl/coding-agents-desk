// `/api/arena/code/*` -- a quick, read-only look into the arena's folders: the arena home with
// every run's folder in it, one run's folder, or one contestant's worktree.
//
// The same reads a Bot's code button makes into its directory (`folderReads.ts`), with the folder
// named by what it belongs to: no `run` is the arena home, a `run` alone is that run's folder, and a
// `run` with a `contestant` is that contestant's worktree. The panel never names a path, so these
// read only folders the arena made, and nothing above or beside them.
//
//   GET tree?expanded=<path>...   the folder as the explorer draws it
//   GET file?path=                one file, read-only
//   GET content?path=             a binary-backed file's bytes
//   GET git/stream                what is uncommitted, now and as it moves
//   GET git/diff?path=            one path's uncommitted change

import type { FolderGitStatus } from "@agentdesk/agent-feed-wire";
import type { ArenaService } from "@/arena/arenaService";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import {
  folderContent,
  folderFile,
  folderGitDiff,
  folderGitStream,
  folderReadError,
  folderTree,
  type FolderReadCodes,
} from "@/http/workspace-routes/folderReads";
import type { WorkspaceFileLimits } from "@/http/workspace-routes/workspaceFileRoutes";
import type { RepositoryGitWatch } from "@/workspace/repositoryWatch";

const CODE_ROUTE = /^\/api\/arena\/code\/(tree|file|content|git\/stream|git\/diff)$/;

const ARENA_FOLDER_CODES: FolderReadCodes = {
  notFound: "arena-path-not-found",
  forbidden: "arena-forbidden",
  invalid: "arena-bad-request",
  unreadable: "arena-file-unreadable",
};

/** A run or contestant the request named that the arena does not have. */
class ArenaPlaceNotFoundError extends Error {}

export function createArenaCodeRoutes(
  service: ArenaService,
  repositories: RepositoryGitWatch,
  limits: WorkspaceFileLimits,
): RouteHandler {
  return (request, url, server) => {
    const read = CODE_ROUTE.exec(url.pathname)?.[1];
    if (!read) return undefined;
    if (request.method !== "GET") {
      return errorResponse("arena-method", `"${request.method}" is not an arena route's method`, 405);
    }
    const path = url.searchParams.get("path");
    const answer = async (): Promise<Response> => {
      try {
        const directory = arenaFolder(service, url.searchParams);
        if (read === "tree") return jsonResponse(await folderTree(directory, url.searchParams.getAll("expanded")));
        if (read === "file") return jsonResponse(await folderFile(directory, path, limits));
        if (read === "content") return await folderContent(directory, path, limits);
        if (read === "git/diff") return jsonResponse(await folderGitDiff(directory, path));
        return await folderGitStream(request, server, directory, repositories, (status: FolderGitStatus) => status);
      } catch (error) {
        if (error instanceof ArenaPlaceNotFoundError) return errorResponse("arena-run-not-found", error.message, 404);
        const refused = folderReadError(error, read === "tree" ? null : path, ARENA_FOLDER_CODES);
        if (refused) return refused;
        console.error("agent feed arena code route failed", error);
        return errorResponse("arena-internal", error instanceof Error ? error.message : String(error), 500);
      }
    };
    return answer();
  };
}

/** The folder a request names: the arena home, a run's folder, or a contestant's worktree. */
function arenaFolder(service: ArenaService, query: URLSearchParams): string {
  const runId = query.get("run");
  if (runId === null) return service.newRunDefaults().arenaHome;
  const run = service.listRuns().find((each) => each.runId === runId);
  if (!run) throw new ArenaPlaceNotFoundError(`no arena run "${runId}"`);
  const contestantId = query.get("contestant");
  if (contestantId === null) return run.folder;
  const contestant = run.contestants.find((each) => each.contestantId === contestantId);
  if (!contestant) throw new ArenaPlaceNotFoundError(`run "${run.name}" has no contestant "${contestantId}"`);
  return contestant.worktreePath;
}
