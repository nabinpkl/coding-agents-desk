// The roster and the shared state: what workspaces exist, and what is open in one.
//
// `/api/workspaces/...` alongside `/api/park/...` and the feed routes. The directory name says what
// these are for; the `agent-feed` above them is the port that is still open (`FEATURE-MAP.md`).

import type { WorkspaceOperation } from "@agentdesk/agent-feed-wire";
import { jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import {
  readJsonBody,
  refusalResponse,
  RequestFailure,
  requiredString,
  workspaceErrorResponse,
  workspaceRecord,
  workspaceRoute,
} from "@/http/workspace-routes/workspaceResponses";
import { browseDirectories, createDirectory } from "@/workspace/workspaceBrowse";
import type { WorkspaceService } from "@/workspace/workspaceService";

const COLLECTION = "/api/workspaces";
const ORDER = "/api/workspaces/order";
const BROWSE = "/api/workspaces/browse";
const FOLDERS = "/api/workspaces/folders";

/**
 * Validate an operation from the wire before it reaches the state store.
 *
 * The store validates paths and permutations itself; what it cannot do is tell a well-formed
 * operation from an arbitrary object, because by the time it sees one it has already been typed.
 */
function parseOperation(value: unknown): WorkspaceOperation {
  if (typeof value !== "object" || value === null) {
    throw new RequestFailure("invalidOperation", "An operation is required.");
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "open":
    case "preview":
    case "close":
    case "expand":
    case "collapse":
      if (typeof record.path !== "string") {
        throw new RequestFailure("invalidOperation", `"${record.type}" needs a path.`);
      }
      return { type: record.type, path: record.path };
    case "reorder":
      if (!Array.isArray(record.orderedPaths)
        || !record.orderedPaths.every((path) => typeof path === "string")) {
        throw new RequestFailure("invalidOperation", '"reorder" needs an array of paths.');
      }
      return { type: "reorder", orderedPaths: record.orderedPaths };
    default:
      throw new RequestFailure("invalidOperation", `unknown operation: ${String(record.type)}`);
  }
}

/**
 * The roster and shared-state routes.
 *
 * The collection is addressed as a collection: listing it, adding to it, and standing it in a
 * new order are all said to `/api/workspaces`, and one workspace is renamed or removed at its
 * own address. So adding is the POST it always was, removing is a DELETE, renaming a PATCH of
 * the one field a rename touches, and reordering a PUT -- it names the roster's whole order
 * and is refused unless that is exactly the permutation the store holds, the same complete
 * replacement the Bot order is. Applying a shared-state operation and writing a file stay
 * POSTs: both are acts with an idempotency story, not settings.
 *
 * The returned handler is deliberately NOT `async`: `RouteHandler` says a handler either answers
 * (possibly with a promise) or returns `undefined` so the next handler gets a look, and an async
 * function's `undefined` is a resolved promise, which reads as an answer. So matching is
 * synchronous here and each match hands back the promise of its own answer.
 */
export function createWorkspaceRoutes(service: WorkspaceService): RouteHandler {
  return (request, url) => {
    const { pathname } = url;

    if (pathname === COLLECTION) {
      if (request.method === "GET") return jsonResponse({ workspaces: service.store.list() });
      if (request.method === "POST") return add(service, request);
      return undefined;
    }
    if (pathname === BROWSE && request.method === "GET") return browse(request);
    // The other half of the picker: making the folder the reader is standing in, which is a POST
    // because it changes the filesystem. Matched on its own method for the same reason BROWSE is.
    if (pathname === FOLDERS && request.method === "POST") return createFolder(request);
    // A complete replacement, refused unless it is exactly the permutation the store holds.
    if (pathname === ORDER && request.method === "PUT") return reorder(service, request);

    // One workspace's own address, after the literals above: a roster id of "order" or "browse"
    // still resolves here, because those only match on their own methods.
    const record = workspaceRecord(pathname);
    if (record !== null) {
      if (request.method === "DELETE") return remove(service, record);
      if (request.method === "PATCH") return rename(service, record, request);
      return undefined;
    }

    const route = workspaceRoute(pathname);
    if (!route) return undefined;
    const { id, action } = route;

    if (action === "tree" && request.method === "GET") {
      if (!service.workspace(id)) return unavailable(id);
      return service.tree(id).then((tree) => jsonResponse({ tree }));
    }
    if (action === "git" && request.method === "GET") {
      if (!service.workspace(id)) return unavailable(id);
      return service.refreshGit(id).then((status) => jsonResponse({ status }));
    }
    if (action === "state" && request.method === "GET") {
      if (!service.workspace(id)) return unavailable(id);
      return jsonResponse({ state: service.sharedState.snapshot(id) });
    }
    if (action === "state" && request.method === "POST") {
      if (!service.workspace(id)) return unavailable(id);
      return applyOperation(service, request, id);
    }

    return undefined;
  };
}

async function add(service: WorkspaceService, request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    const name = typeof body.name === "string" ? body.name : undefined;
    const workspace = await service.store.add(requiredString(body, "root"), name);
    return jsonResponse({ workspace });
  } catch (error) {
    return refusalResponse(error);
  }
}

async function remove(service: WorkspaceService, id: string): Promise<Response> {
  try {
    await service.store.remove(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return refusalResponse(error);
  }
}

async function rename(service: WorkspaceService, id: string, request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    await service.store.rename(id, requiredString(body, "name"));
    return new Response(null, { status: 204 });
  } catch (error) {
    return refusalResponse(error);
  }
}

/**
 * List the directories inside one directory, for the panel's folder picker.
 *
 * Takes no workspace: this is how a workspace gets chosen in the first place. Confined to the home
 * directory by `browseDirectories`, which is where the reasoning for that lives.
 */
async function browse(request: Request): Promise<Response> {
  try {
    const asked = new URL(request.url).searchParams.get("path");
    return jsonResponse(await browseDirectories(asked));
  } catch (error) {
    return refusalResponse(error);
  }
}

/**
 * Make a folder inside the directory the picker is looking at.
 *
 * `path` is that directory and `name` the folder to put in it, rather than a full path: the whole
 * point of the picker is that the reader names a folder, not that they assemble an absolute path
 * they cannot see. The answer is the new folder's listing, so the panel can stand in it.
 */
async function createFolder(request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    return jsonResponse({
      listing: await createDirectory(requiredString(body, "path"), requiredString(body, "name")),
    });
  } catch (error) {
    return refusalResponse(error);
  }
}

async function reorder(service: WorkspaceService, request: Request): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
      throw new RequestFailure("invalidOperation", '"ids" must be an array of workspace ids.');
    }
    await service.store.reorder(body.ids);
    return new Response(null, { status: 204 });
  } catch (error) {
    return refusalResponse(error);
  }
}

async function applyOperation(
  service: WorkspaceService,
  request: Request,
  id: string,
): Promise<Response> {
  try {
    const body = await readJsonBody(request);
    if (typeof body.baseRevision !== "number" || !Number.isInteger(body.baseRevision)) {
      throw new RequestFailure("invalidOperation", '"baseRevision" must be an integer.');
    }
    const state = await service.sharedState.apply(
      id,
      body.baseRevision,
      requiredString(body, "operationId"),
      parseOperation(body.operation),
    );
    return jsonResponse({ state });
  } catch (error) {
    return refusalResponse(error, id);
  }
}

function unavailable(id: string): Response {
  return workspaceErrorResponse("workspaceUnavailable", "Workspace is unavailable.", id);
}
