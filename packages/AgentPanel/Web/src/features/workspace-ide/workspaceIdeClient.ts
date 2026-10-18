// Every call the IDE makes to its sidecar, in one place.
//
// A thin object over `AgentHttpTransport` rather than fetches scattered through components: the
// panel reaches whichever sidecar the session picker chose, and a component that called `fetch`
// directly would silently answer the default one.

import type {
  WorkspaceChangeDiff,
  WorkspaceCommit,
  WorkspaceCommitDetail,
  WorkspaceCommitDiff,
  WorkspaceFileConflict,
  WorkspaceFileList,
  WorkspaceFileRead,
  WorkspaceFileWritten,
  WorkspaceGitStatus,
  WorkspaceOperation,
  WorkspaceSearchOptions,
  WorkspaceSearchResult,
  WorkspaceSharedState,
  WorkspaceStreamEvent,
  WorkspaceBrowseListing,
  WorkspaceFolderCreated,
  WorkspaceSummary,
  WorkspaceTreeNode,
} from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";

/** A refusal the sidecar answered with, carrying the code the surface renders. */
export class WorkspaceRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WorkspaceRequestError";
  }
}

function parse<T>(status: number, body: string): T {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new WorkspaceRequestError("internal", `the sidecar answered ${status} with no JSON`, status);
  }
  if (status >= 400) {
    const error = (payload as { error?: { code?: string; message?: string } }).error;
    throw new WorkspaceRequestError(
      error?.code ?? "internal",
      error?.message ?? `request failed with ${status}`,
      status,
    );
  }
  return payload as T;
}

export class WorkspaceIdeClient {
  constructor(private readonly transport: AgentHttpTransport) {}

  private async call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.transport.request(method, path, {
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
    });
    if (response.status === 204) return undefined as T;
    return parse<T>(response.status, response.body);
  }

  listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
    return this.call("GET", "/api/workspaces");
  }

  /**
   * The directories inside one directory, for choosing a workspace root.
   *
   * A null path means "start where the sidecar starts", which is the home directory. The browser
   * cannot know that, and hard-coding it here would be a second place holding the answer.
   */
  browse(path: string | null): Promise<WorkspaceBrowseListing> {
    const query = path === null ? "" : `?path=${encodeURIComponent(path)}`;
    return this.call("GET", `/api/workspaces/browse${query}`);
  }

  /**
   * Make a folder inside `path`, and stand in it.
   *
   * The new folder's listing rather than its path, because that is what the picker needs next and
   * because the path the sidecar answers with is the resolved one. Same shape as the browse beside
   * it, so the picker does not have to know which client it was handed.
   */
  async createFolder(path: string, name: string): Promise<WorkspaceBrowseListing> {
    const created = await this.call<WorkspaceFolderCreated>("POST", "/api/workspaces/folders", { path, name });
    return created.listing;
  }

  addWorkspace(root: string, name?: string): Promise<{ workspace: WorkspaceSummary }> {
    return this.call("POST", "/api/workspaces", { root, name });
  }

  removeWorkspace(id: string): Promise<void> {
    return this.call("DELETE", `/api/workspaces/${encodeURIComponent(id)}`);
  }

  renameWorkspace(id: string, name: string): Promise<void> {
    return this.call("PATCH", `/api/workspaces/${encodeURIComponent(id)}`, { name });
  }

  /**
   * Set the roster's order.
   *
   * The whole order every time, not a move: the store takes a permutation and refuses one that is
   * not, so sending two indices would make the caller responsible for a rule the store already
   * owns. A PUT for the same reason: stating the whole order is what makes a stale roster
   * detectable.
   */
  reorderWorkspaces(ids: readonly string[]): Promise<void> {
    return this.call("PUT", "/api/workspaces/order", { ids: [...ids] });
  }

  tree(id: string): Promise<{ tree: WorkspaceTreeNode[] }> {
    return this.call("GET", `/api/workspaces/${encodeURIComponent(id)}/tree`);
  }

  /** Every file quick open can offer, fetched once per opening of the picker. */
  files(id: string, signal?: AbortSignal): Promise<WorkspaceFileList> {
    return this.call("GET", `/api/workspaces/${encodeURIComponent(id)}/files`, undefined, signal);
  }

  /**
   * The lines that match a text search. Aborting the signal is how a search the reader has typed
   * past is cancelled: the sidecar hands the request's own signal to `rg`, so the process dies too.
   */
  search(
    id: string,
    query: string,
    options: WorkspaceSearchOptions,
    signal?: AbortSignal,
  ): Promise<WorkspaceSearchResult> {
    const parameters = new URLSearchParams({ q: query });
    if (options.matchCase) parameters.set("case", "1");
    if (options.wholeWord) parameters.set("word", "1");
    if (options.regex) parameters.set("regex", "1");
    if (options.include.length > 0) parameters.set("include", options.include.join(","));
    if (options.exclude.length > 0) parameters.set("exclude", options.exclude.join(","));
    return this.call("GET", `/api/workspaces/${encodeURIComponent(id)}/search?${parameters}`, undefined, signal);
  }

  git(id: string): Promise<{ status: WorkspaceGitStatus }> {
    return this.call("GET", `/api/workspaces/${encodeURIComponent(id)}/git`);
  }

  /**
   * The commits on the workspace's current branch, newest first.
   *
   * The limit travels rather than being the sidecar's to choose, because the panel is the half that
   * knows whether the reader has asked for more: the popup opens on one page and grows.
   */
  commits(id: string, limit: number): Promise<{ commits: WorkspaceCommit[] }> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.call("GET", `/api/workspaces/${encodeURIComponent(id)}/commits?${query}`);
  }

  /** What one commit touched, against the commit before it. */
  commit(id: string, hash: string): Promise<{ detail: WorkspaceCommitDetail }> {
    const query = new URLSearchParams({ hash });
    return this.call("GET", `/api/workspaces/${encodeURIComponent(id)}/commit?${query}`);
  }

  /**
   * The patch for one path in one commit.
   *
   * One path per request rather than the commit's whole patch: a reader who expanded a commit is
   * looking at a list of files, and has asked for none of them yet.
   */
  commitDiff(id: string, hash: string, path: string): Promise<{ diff: WorkspaceCommitDiff }> {
    const query = new URLSearchParams({ hash, path });
    return this.call("GET", `/api/workspaces/${encodeURIComponent(id)}/diff?${query}`);
  }

  /** One path's uncommitted change against `HEAD`, staged and unstaged together. */
  changeDiff(id: string, path: string): Promise<{ diff: WorkspaceChangeDiff }> {
    const query = new URLSearchParams({ path });
    return this.call("GET", `/api/workspaces/${encodeURIComponent(id)}/change?${query}`);
  }

  /**
   * Apply one shared-state change.
   *
   * The operation id is minted here rather than by the caller so every mutation has one, which is
   * what makes a retry after a dropped response a no-op instead of a second open.
   */
  applyOperation(
    id: string,
    baseRevision: number,
    operation: WorkspaceOperation,
  ): Promise<{ state: WorkspaceSharedState }> {
    return this.call("POST", `/api/workspaces/${encodeURIComponent(id)}/state`, {
      baseRevision,
      operationId: crypto.randomUUID(),
      operation,
    });
  }

  readFile(id: string, path: string): Promise<{ file: WorkspaceFileRead }> {
    const query = new URLSearchParams({ path });
    return this.call("GET", `/api/workspaces/${encodeURIComponent(id)}/file?${query}`);
  }

  /**
   * Where a binary-backed document's bytes are fetched from, for its renderer. Null where the
   * transport has no address the page can load on its own.
   */
  contentUrl(id: string, path: string): string | null {
    const query = new URLSearchParams({ path });
    return this.transport.resourceUrl?.(`/api/workspaces/${encodeURIComponent(id)}/content?${query}`) ?? null;
  }

  /**
   * Write a file, answering the conflict rather than throwing it.
   *
   * A conflict is a normal outcome of two people editing one file, and the surface resolves it by
   * asking. Making it an exception would put a routine decision on the error path.
   */
  async writeFile(
    id: string,
    path: string,
    expectedRevision: string,
    text: string,
  ): Promise<
    { status: "written"; written: WorkspaceFileWritten } | { status: "conflict"; conflict: WorkspaceFileConflict }
  > {
    const response = await this.transport.request("POST", `/api/workspaces/${encodeURIComponent(id)}/file`, {
      body: { path, expectedRevision, text },
    });
    if (response.status === 409) {
      const payload = JSON.parse(response.body) as { conflict?: WorkspaceFileConflict };
      // A 409 is also how a read-only kind is refused, and that has no conflict body.
      if (payload.conflict) return { status: "conflict", conflict: payload.conflict };
    }
    const written = parse<{ written: WorkspaceFileWritten }>(response.status, response.body);
    return { status: "written", written: written.written };
  }

  /** Follow one workspace's stream. Returns unsubscribe. */
  subscribe(id: string, onEvent: (event: WorkspaceStreamEvent) => void, onError: (reason: string) => void): () => void {
    return this.transport.subscribe(`/api/workspaces/${encodeURIComponent(id)}/stream`, {
      onMessage: (payload) => {
        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          onError("the workspace stream sent something that is not JSON");
          return;
        }
        // The stream also carries the shared lag notice, which is an error rather than an event.
        if (typeof event === "object" && event !== null && "error" in event) {
          onError(String((event as { error: { message?: string } }).error.message ?? "stream error"));
          return;
        }
        onEvent(event as WorkspaceStreamEvent);
      },
      onError,
    });
  }
}
