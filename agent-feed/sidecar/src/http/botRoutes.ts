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
  BotNotFoundError,
  type BotRegistry,
} from "@/bots/botRegistry";
import { decodeBotId, errorPayload, requestObject, routeError } from "@/http/botRouteProtocol";
import {
  encodeServerSentEvent,
  errorResponse,
  jsonResponse,
  startServerSentEventStream,
} from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import {
  folderContent,
  folderFile,
  folderGitDiff,
  folderGitStream,
  FolderReadInvalidError,
  folderReadError,
  folderTree,
  type FolderReadCodes,
} from "@/http/workspace-routes/folderReads";
import type { WorkspaceFileLimits } from "@/http/workspace-routes/workspaceFileRoutes";
import type { RepositoryGitWatch } from "@/workspace/repositoryWatch";
import { WorkspaceFailure } from "@/workspace/workspacePaths";

const BOTS_ROUTE = "/api/bots";
const BOTS_STREAM_ROUTE = "/api/bots/stream";
const PLACEMENTS_ROUTE = "/api/bots/placements";

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

/** The Bot routes' spelling of the folder reads' refusals. */
const BOT_FOLDER_CODES: FolderReadCodes = {
  notFound: "bot-path-not-found",
  forbidden: "bot-forbidden",
  invalid: "invalid-bot",
  unreadable: "bot-file-unreadable",
};

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
    return await folderGitStream(request, server, directory, repositories, (status): BotGitStatus => ({
      botId: decodedBotId,
      ...status,
    }));
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
    const directory = await botDirectory(botId, registry);
    const answer: BotGitDiff = { botId: decodeBotId(botId), ...(await folderGitDiff(directory, path)) };
    return jsonResponse(answer);
  } catch (error) {
    // The workspace's refusals, spelled the way this route spells its own: a path that is not a
    // change is a missing resource, and one that is not a relative path is a bad request.
    if (error instanceof WorkspaceFailure && error.code === "notFound") {
      return errorResponse("bot-git-path-not-found", `"${path}" has no uncommitted change`, 404);
    }
    if (error instanceof WorkspaceFailure || error instanceof FolderReadInvalidError) {
      return errorResponse("invalid-bot", error.message, 400);
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
    const directory = await botDirectory(botId, registry);
    const answer: BotTree = { botId: decodeBotId(botId), ...(await folderTree(directory, expanded)) };
    return jsonResponse(answer);
  } catch (error) {
    return folderReadError(error, null, BOT_FOLDER_CODES) ?? routeError(error);
  }
}

async function botFile(
  botId: string,
  path: string | null,
  registry: BotRegistry,
  limits: WorkspaceFileLimits,
): Promise<Response> {
  try {
    const directory = await botDirectory(botId, registry);
    const answer: BotFileRead = { botId: decodeBotId(botId), ...(await folderFile(directory, path, limits)) };
    return jsonResponse(answer);
  } catch (error) {
    return folderReadError(error, path, BOT_FOLDER_CODES) ?? routeError(error);
  }
}

async function botContent(
  botId: string,
  path: string | null,
  registry: BotRegistry,
  limits: WorkspaceFileLimits,
): Promise<Response> {
  try {
    return await folderContent(await botDirectory(botId, registry), path, limits);
  } catch (error) {
    return folderReadError(error, path, BOT_FOLDER_CODES) ?? routeError(error);
  }
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
