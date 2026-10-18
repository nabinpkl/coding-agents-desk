// The reads behind a quick, read-only look into a folder that is not a workspace: its tree, one
// file, one file's bytes, one path's uncommitted change, and its git status as it moves.
//
// Written once for every owner of such a folder -- a Bot's directory, an arena run's folder, a
// contestant's worktree -- because each is the IDE's own tree and reads with a different root. The
// owner's routes resolve the folder from what it belongs to, never from a path in the request,
// which is the confinement: a request names a Bot or a run, and these reads then refuse any path
// that leaves the folder, the way the IDE refuses one that leaves a workspace.

import type { FolderFileRead, FolderGitDiff, FolderGitStatus, FolderTree } from "@agentdesk/agent-feed-wire";
import { encodeServerSentEvent, errorResponse, startServerSentEventStream } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import { documentResponse, type WorkspaceFileLimits } from "@/http/workspace-routes/workspaceFileRoutes";
import type { RepositoryGitWatch } from "@/workspace/repositoryWatch";
import { fileKind, isBinaryKind, readDocumentFile, readTextFile } from "@/workspace/workspaceFiles";
import { directoryGitEntries, workingTreeFileDiff } from "@/workspace/workspaceGit";
import { WorkspaceFailure } from "@/workspace/workspacePaths";
import { buildTree } from "@/workspace/workspaceTree";

/**
 * How many expanded directories one tree request may name. Each one that is reachable costs a
 * directory read, and the caller is unauthenticated; a reader expands a handful.
 */
const MAXIMUM_EXPANDED_PATHS = 512;

/** A request the folder reads refuse before touching the disk: a bad request, in the owner's words. */
export class FolderReadInvalidError extends Error {}

export async function folderTree(directory: string, expanded: readonly string[]): Promise<FolderTree> {
  if (expanded.length > MAXIMUM_EXPANDED_PATHS) {
    throw new FolderReadInvalidError(`at most ${MAXIMUM_EXPANDED_PATHS} expanded directories`);
  }
  return { tree: await buildTree(directory, [...expanded], await directoryGitEntries(directory)) };
}

export async function folderFile(
  directory: string,
  path: string | null,
  limits: WorkspaceFileLimits,
): Promise<FolderFileRead> {
  if (!path) throw new FolderReadInvalidError("path is required");
  const kind = fileKind(path);
  // A binary-backed file is read to prove it is there and within bounds, and answered without
  // its bytes, which the content read carries.
  const read = isBinaryKind(kind)
    ? { ...(await readDocumentFile(directory, path, limits.maxDocumentBytes)), text: null }
    : await readTextFile(directory, path, limits.maxTextBytes);
  return { path, kind, revision: read.revision, text: read.text };
}

/** A binary-backed file's bytes, which its read above answers without. */
export async function folderContent(
  directory: string,
  path: string | null,
  limits: WorkspaceFileLimits,
): Promise<Response> {
  if (!path) throw new FolderReadInvalidError("path is required");
  return documentResponse(await readDocumentFile(directory, path, limits.maxDocumentBytes));
}

export async function folderGitDiff(directory: string, path: string | null): Promise<FolderGitDiff> {
  if (!path) throw new FolderReadInvalidError("path is required");
  return { path, ...(await workingTreeFileDiff(directory, path)) };
}

/**
 * The folder's git status now, and again whenever it moves: pushed from the repository watch the
 * IDE reads too, rather than asked for on a timer. The owner resolves the folder before the stream
 * opens, so an unknown owner is an ordinary error response instead of a stream that says nothing.
 */
export function folderGitStream<Status extends FolderGitStatus>(
  request: Request,
  server: Parameters<RouteHandler>[2],
  directory: string,
  repositories: RepositoryGitWatch,
  answer: (status: FolderGitStatus) => Status,
): Response | Promise<Response> {
  return startServerSentEventStream(request, server, (write) =>
    repositories.subscribe(directory, (status) => {
      write(
        encodeServerSentEvent(
          answer({
            repository: status !== null,
            branch: status?.branch ?? null,
            entries: status?.entries ?? [],
          }),
        ),
      );
    }),
  );
}

/** The error codes one owner spells the folder reads' refusals with. */
export interface FolderReadCodes {
  /** A path that is not there, or a change that is not one: 404. */
  notFound: string;
  /** A path that escapes the folder: 403. */
  forbidden: string;
  /** A request that is malformed: 400. */
  invalid: string;
  /** A file that is there but cannot be shown -- binary, too large, not UTF-8: 422. */
  unreadable: string;
}

/**
 * The folder reads' refusals as a response in the owner's codes, or null for an error that is not
 * one of theirs, which the owner answers itself.
 */
export function folderReadError(error: unknown, path: string | null, codes: FolderReadCodes): Response | null {
  if (error instanceof FolderReadInvalidError) return errorResponse(codes.invalid, error.message, 400);
  if (!(error instanceof WorkspaceFailure)) return null;
  const subject = path === null ? "" : ` (${path})`;
  if (error.code === "notFound") return errorResponse(codes.notFound, `${error.message}${subject}`, 404);
  if (error.code === "forbidden") return errorResponse(codes.forbidden, error.message, 403);
  if (error.code === "invalidPath") return errorResponse(codes.invalid, error.message, 400);
  return errorResponse(codes.unreadable, `${error.message}${subject}`, 422);
}
