import type {
  AddBotCommand,
  AddBotSessionsCommand,
  BotFileRead,
  BotGitDiff,
  BotGitStatus,
  BotTree,
  DetachBotSessionsCommand,
  PlaceBotSessionCommand,
  ReorderBotSessionsCommand,
  RetireBotSessionsCommand,
  SetBotCanvasCommand,
  UpdateBotCommand,
} from "@agentdesk/agent-feed-wire";
import {
  BotConflictError,
  BotInvalidError,
  BotNotFoundError,
  type BotRegistry,
} from "@/bots/botRegistry";
import { decodeBotId, errorPayload, requestObject, routeError } from "@/http/botRouteProtocol";
import {
  encodeServerSentEvent,
  errorResponse,
  jsonResponse,
  startServerSentEventStream,
} from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";
import {
  documentResponse,
  type WorkspaceFileLimits,
} from "@/http/workspace-routes/workspaceFileRoutes";
import type { RepositoryGitWatch } from "@/workspace/repositoryWatch";
import { fileKind, isBinaryKind, readDocumentFile, readTextFile } from "@/workspace/workspaceFiles";
import { directoryGitEntries, workingTreeFileDiff } from "@/workspace/workspaceGit";
import { WorkspaceFailure } from "@/workspace/workspacePaths";
import { buildTree } from "@/workspace/workspaceTree";

const BOTS_ROUTE = "/api/bots";
const BOTS_STREAM_ROUTE = "/api/bots/stream";
const PLACEMENTS_ROUTE = "/api/bots/placements";
/**
 * How many expanded directories one tree request may name. Each one that is reachable costs a
 * directory read, and the caller is unauthenticated; a reader expands a handful.
 */
const MAXIMUM_EXPANDED_PATHS = 512;

export function createBotRoutes(
  registry: BotRegistry,
  repositories: RepositoryGitWatch,
  limits: WorkspaceFileLimits,
): RouteHandler {
  return (request, url, server) => {
    if (request.method === "GET" && url.pathname === BOTS_ROUTE) {
      return registry.snapshot().then((snapshot) => jsonResponse(snapshot), routeError);
    }
    if (request.method === "GET" && url.pathname === BOTS_STREAM_ROUTE) {
      return startServerSentEventStream(request, server, (write) => {
        let closed = false;
        let unsubscribe: (() => void) | undefined;
        void registry.subscribe(
          (snapshot) => write(encodeServerSentEvent(snapshot)),
          (error) => write(encodeServerSentEvent({ error: errorPayload(error) })),
          // `"view"`, because this stream feeds a canvas and a roster that draw a row per resolved
          // session and a row per unresolved reference. The hub publishes membership and wants the
          // store's revision; this one has to hear about a reference that started or stopped
          // resolving, or a restart's half-reconciled catalog becomes the panel's picture for as
          // long as the reader does not touch a Bot.
          { onChange: "view" },
        )
          .then((stop) => {
            if (closed) stop();
            else unsubscribe = stop;
          })
          .catch((error) => write(encodeServerSentEvent({ error: errorPayload(error) })));
        return () => {
          closed = true;
          unsubscribe?.();
        };
      });
    }
    if (request.method === "POST" && url.pathname === BOTS_ROUTE) {
      return createBot(request, registry);
    }
    // Ahead of the per-Bot matches, because `placements` would otherwise read as a Bot id.
    if (request.method === "POST" && url.pathname === PLACEMENTS_ROUTE) {
      return placeSession(request, registry);
    }
    // One session's bracket moved to its own address: `POST
    // /api/sessions/:source/:sessionId/bracket`, beside the session routes. Renaming a bracket
    // is something done to a session, and the literal `sessions` below would otherwise read as
    // a Bot id -- which is why this comment sits ahead of that match rather than where the
    // route used to be.
    const sessionsMatch = /^\/api\/bots\/([^/]+)\/sessions$/.exec(url.pathname);
    if (request.method === "POST" && sessionsMatch) {
      return addBotSessions(request, sessionsMatch[1]!, registry);
    }
    // Removal is a DELETE on the collection above: the verb says what the path cannot, and
    // that is what keeps a body naming sessionRefs from reading as an attach. The relay is dead
    // so no allow-list shapes this any more; the method is chosen for what the call does.
    const detachMatch = /^\/api\/bots\/([^/]+)\/sessions$/.exec(url.pathname);
    if (request.method === "DELETE" && detachMatch) {
      return detachBotSessions(request, detachMatch[1]!, registry);
    }
    // Retiring is detaching plus everything the launch created, so it keeps its own path while
    // detaching moved onto the verb: a POST, because it triggers disposals rather than deleting a
    // resource, and a body that would be meaningless on a DELETE.
    const retireMatch = /^\/api\/bots\/([^/]+)\/sessions\/retire$/.exec(url.pathname);
    if (request.method === "POST" && retireMatch) {
      return retireBotSessions(request, retireMatch[1]!, registry);
    }
    // Reordering is neither of those: the same references, standing differently. A PUT, because
    // the call names the Bot's whole order and is refused unless that is exactly what the Bot
    // holds -- a complete replacement, not a patch. Its own path for the reason detach states:
    // a body naming sessionRefs on `/sessions` ATTACHES them.
    const orderMatch = /^\/api\/bots\/([^/]+)\/sessions\/order$/.exec(url.pathname);
    if (request.method === "PUT" && orderMatch) {
      return reorderBotSessions(request, orderMatch[1]!, registry);
    }
    const canvasMatch = /^\/api\/bots\/([^/]+)\/canvas$/.exec(url.pathname);
    if (request.method === "PATCH" && canvasMatch) {
      return setBotCanvas(request, canvasMatch[1]!, registry);
    }
    // One Bot's record, renamed, restyled, or given its Father -- or forgotten entirely.
    // PATCH carries the fields to change, DELETE carries nothing but the address: the body
    // must still parse as an object, so the panel sends an empty one.
    const botMatch = /^\/api\/bots\/([^/]+)$/.exec(url.pathname);
    if (request.method === "PATCH" && botMatch) {
      return updateBot(request, botMatch[1]!, registry);
    }
    if (request.method === "DELETE" && botMatch) {
      return deleteBot(botMatch[1]!, registry);
    }
    // What is uncommitted in the Bot's directory, as it changes, and one path of it. The Bot's own
    // paths rather than the IDE's: see `BotGitStatus` for why a Bot is not a workspace.
    const gitStreamMatch = /^\/api\/bots\/([^/]+)\/git\/stream$/.exec(url.pathname);
    if (request.method === "GET" && gitStreamMatch) {
      return botGitStream(request, server, gitStreamMatch[1]!, registry, repositories);
    }
    const gitDiffMatch = /^\/api\/bots\/([^/]+)\/git\/diff$/.exec(url.pathname);
    if (request.method === "GET" && gitDiffMatch) {
      return botGitDiff(gitDiffMatch[1]!, url.searchParams.get("path"), registry);
    }
    // The Bot's files, read-only, for a quick look into its code. The IDE's tree and reads, with
    // the Bot's directory as the root: see `BotTree` for why expansion travels with the request.
    const treeMatch = /^\/api\/bots\/([^/]+)\/tree$/.exec(url.pathname);
    if (request.method === "GET" && treeMatch) {
      return botTree(treeMatch[1]!, url.searchParams.getAll("expanded"), registry);
    }
    const fileMatch = /^\/api\/bots\/([^/]+)\/file$/.exec(url.pathname);
    if (request.method === "GET" && fileMatch) {
      return botFile(fileMatch[1]!, url.searchParams.get("path"), registry, limits);
    }
    // A binary-backed file's bytes, which its read above answers without.
    const contentMatch = /^\/api\/bots\/([^/]+)\/content$/.exec(url.pathname);
    if (request.method === "GET" && contentMatch) {
      return botContent(contentMatch[1]!, url.searchParams.get("path"), registry, limits);
    }
    return undefined;
  };
}

/**
 * The directory a Bot is bound to, from the roster rather than from the request.
 *
 * Only a Bot's own directory can be read this way, which is the confinement: the panel names a Bot,
 * never a path on the disk.
 */
async function botDirectory(botId: string, registry: BotRegistry): Promise<string> {
  const decodedBotId = decodeBotId(botId);
  const bot = (await registry.snapshot()).bots.find((each) => each.botId === decodedBotId);
  if (!bot) throw new BotNotFoundError(`no Bot "${decodedBotId}"`);
  if (bot.environmentAvailability === "missing") {
    throw new BotConflictError(`the directory of "${bot.name}" is missing`);
  }
  return bot.environment.path;
}

/**
 * The Bot's directory's git status now, and again whenever it moves.
 *
 * Pushed from the repository watch the IDE reads too, rather than asked for on a timer: the
 * directory is resolved once, when the stream opens, so an unknown Bot or a missing directory is an
 * ordinary error response instead of a stream that opens and says nothing.
 */
async function botGitStream(
  request: Request,
  server: Parameters<RouteHandler>[2],
  botId: string,
  registry: BotRegistry,
  repositories: RepositoryGitWatch,
): Promise<Response> {
  try {
    const directory = await botDirectory(botId, registry);
    const decodedBotId = decodeBotId(botId);
    return startServerSentEventStream(request, server, (write) =>
      repositories.subscribe(directory, (status) => {
        const answer: BotGitStatus = {
          botId: decodedBotId,
          repository: status !== null,
          branch: status?.branch ?? null,
          entries: status?.entries ?? [],
        };
        write(encodeServerSentEvent(answer));
      }),
    );
  } catch (error) {
    return routeError(error);
  }
}

async function botGitDiff(
  botId: string,
  path: string | null,
  registry: BotRegistry,
): Promise<Response> {
  try {
    if (!path) throw new BotInvalidError("path is required");
    const directory = await botDirectory(botId, registry);
    const diff = await workingTreeFileDiff(directory, path);
    const answer: BotGitDiff = { botId: decodeBotId(botId), path, ...diff };
    return jsonResponse(answer);
  } catch (error) {
    // The workspace's refusals, spelled the way this route spells its own: a path that is not a
    // change is a missing resource, and one that is not a relative path is a bad request.
    if (error instanceof WorkspaceFailure) {
      return error.code === "notFound"
        ? errorResponse("bot-git-path-not-found", `"${path}" has no uncommitted change`, 404)
        : errorResponse("invalid-bot", error.message, 400);
    }
    return routeError(error);
  }
}

async function botTree(
  botId: string,
  expanded: string[],
  registry: BotRegistry,
): Promise<Response> {
  try {
    if (expanded.length > MAXIMUM_EXPANDED_PATHS) {
      throw new BotInvalidError(`at most ${MAXIMUM_EXPANDED_PATHS} expanded directories`);
    }
    const directory = await botDirectory(botId, registry);
    const tree = await buildTree(directory, expanded, await directoryGitEntries(directory));
    const answer: BotTree = { botId: decodeBotId(botId), tree };
    return jsonResponse(answer);
  } catch (error) {
    return fileRouteError(error, null);
  }
}

async function botFile(
  botId: string,
  path: string | null,
  registry: BotRegistry,
  limits: WorkspaceFileLimits,
): Promise<Response> {
  try {
    if (!path) throw new BotInvalidError("path is required");
    const directory = await botDirectory(botId, registry);
    const kind = fileKind(path);
    // A binary-backed file is read to prove it is there and within bounds, and answered without
    // its bytes, which the content route carries.
    const read = isBinaryKind(kind)
      ? { ...(await readDocumentFile(directory, path, limits.maxDocumentBytes)), text: null }
      : await readTextFile(directory, path, limits.maxTextBytes);
    const answer: BotFileRead = {
      botId: decodeBotId(botId),
      path,
      kind,
      revision: read.revision,
      text: read.text,
    };
    return jsonResponse(answer);
  } catch (error) {
    return fileRouteError(error, path);
  }
}

async function botContent(
  botId: string,
  path: string | null,
  registry: BotRegistry,
  limits: WorkspaceFileLimits,
): Promise<Response> {
  try {
    if (!path) throw new BotInvalidError("path is required");
    const directory = await botDirectory(botId, registry);
    return documentResponse(await readDocumentFile(directory, path, limits.maxDocumentBytes));
  } catch (error) {
    return fileRouteError(error, path);
  }
}

/**
 * The workspace's path refusals, spelled the way the Bot routes spell theirs. A path that is not
 * there is a missing resource, one that escapes the directory is forbidden, and a file that is
 * there but cannot be shown -- binary, too large, not UTF-8 -- says which in its message.
 */
function fileRouteError(error: unknown, path: string | null): Response {
  if (!(error instanceof WorkspaceFailure)) return routeError(error);
  const subject = path === null ? "" : ` (${path})`;
  if (error.code === "notFound") {
    return errorResponse("bot-path-not-found", `${error.message}${subject}`, 404);
  }
  if (error.code === "forbidden") return errorResponse("bot-forbidden", error.message, 403);
  if (error.code === "invalidPath") return errorResponse("invalid-bot", error.message, 400);
  return errorResponse("bot-file-unreadable", `${error.message}${subject}`, 422);
}

async function createBot(request: Request, registry: BotRegistry): Promise<Response> {
  try {
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(await registry.add(body as unknown as AddBotCommand, { kind: "user" }), 201);
  } catch (error) {
    return routeError(error);
  }
}

async function placeSession(request: Request, registry: BotRegistry): Promise<Response> {
  try {
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    const placed = await registry.placeSession(body as unknown as PlaceBotSessionCommand, { kind: "user" });
    return jsonResponse(placed, placed.created ? 201 : 200);
  } catch (error) {
    return routeError(error);
  }
}

async function addBotSessions(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.addSessions(decodedBotId, body as unknown as AddBotSessionsCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
  }
}

async function detachBotSessions(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.detachSessions(decodedBotId, body as unknown as DetachBotSessionsCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
  }
}

async function retireBotSessions(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.retireSessions(decodedBotId, body as unknown as RetireBotSessionsCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
  }
}

async function reorderBotSessions(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.reorderSessions(decodedBotId, body as unknown as ReorderBotSessionsCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
  }
}

async function setBotCanvas(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.setCanvas(decodedBotId, body as unknown as SetBotCanvasCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
  }
}

async function updateBot(
  request: Request,
  botId: string,
  registry: BotRegistry,
): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    const body = await requestObject(request);
    if (body instanceof Response) return body;
    return jsonResponse(
      await registry.updateBot(decodedBotId, body as unknown as UpdateBotCommand, { kind: "user" }),
    );
  } catch (error) {
    return routeError(error);
  }
}

async function deleteBot(botId: string, registry: BotRegistry): Promise<Response> {
  try {
    const decodedBotId = decodeBotId(botId);
    return jsonResponse(await registry.deleteBot(decodedBotId, { kind: "user" }));
  } catch (error) {
    return routeError(error);
  }
}
