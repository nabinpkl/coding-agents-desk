// Every call the IDE makes to its sidecar, in one place.
//
// A thin object over `AgentHttpTransport` rather than fetches scattered through components: the
// panel reaches whichever sidecar the session picker chose, and a component that called `fetch`
// directly would silently answer the default one.

import type {
  WorkspaceCommit,
  WorkspaceCommitDetail,
  WorkspaceCommitDiff,
  WorkspaceFileConflict,
  WorkspaceFileRead,
  WorkspaceFileWritten,
  WorkspaceGitStatus,
  WorkspaceOperation,
  WorkspaceSharedState,
  WorkspaceStreamEvent,
  WorkspaceBrowseListing,
  WorkspaceSummary,
  WorkspaceTreeNode,
} from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";

/** A refusal the sidecar answered with, carrying the code the surface renders. */
export class WorkspaceRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
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

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.transport.request(method, path, body === undefined ? {} : { body });
    if (response.status === 204) return undefined as T;
    return parse<T>(response.status, response.body);
  }

  listWorkspaces(): Promise<{ workspaces: WorkspaceSummary[] }> {
    return this.call("GET", "/api/workspace/list");
  }

  /**
   * The directories inside one directory, for choosing a workspace root.
   *
   * A null path means "start where the sidecar starts", which is the home directory. The browser
   * cannot know that, and hard-coding it here would be a second place holding the answer.
   */
  browse(path: string | null): Promise<WorkspaceBrowseListing> {
    const query = path === null ? "" : `?path=${encodeURIComponent(path)}`;
    return this.call("GET", `/api/workspace/browse${query}`);
  }

  addWorkspace(root: string, name?: string): Promise<{ workspace: WorkspaceSummary }> {
    return this.call("POST", "/api/workspace/add", { root, name });
  }

  removeWorkspace(id: string): Promise<void> {
    return this.call("POST", "/api/workspace/remove", { id });
  }

  renameWorkspace(id: string, name: string): Promise<void> {
    return this.call("POST", "/api/workspace/rename", { id, name });
  }

  /**
   * Set the roster's order.
   *
   * The whole order every time, not a move: the store takes a permutation and refuses one that is
   * not, so sending two indices would make the caller responsible for a rule the store already
   * owns.
   */
  reorderWorkspaces(ids: readonly string[]): Promise<void> {
    return this.call("POST", "/api/workspace/reorder", { ids: [...ids] });
  }

  tree(id: string): Promise<{ tree: WorkspaceTreeNode[] }> {
    return this.call("GET", `/api/workspace/${encodeURIComponent(id)}/tree`);
  }

  git(id: string): Promise<{ status: WorkspaceGitStatus }> {
    return this.call("GET", `/api/workspace/${encodeURIComponent(id)}/git`);
  }

  /**
   * The commits on the workspace's current branch, newest first.
   *
   * The limit travels rather than being the sidecar's to choose, because the panel is the half that
   * knows whether the reader has asked for more: the popup opens on one page and grows.
   */
  commits(id: string, limit: number): Promise<{ commits: WorkspaceCommit[] }> {
    const query = new URLSearchParams({ limit: String(limit) });
    return this.call("GET", `/api/workspace/${encodeURIComponent(id)}/commits?${query}`);
  }

  /** What one commit touched, against the commit before it. */
  commit(id: string, hash: string): Promise<{ detail: WorkspaceCommitDetail }> {
    const query = new URLSearchParams({ hash });
    return this.call("GET", `/api/workspace/${encodeURIComponent(id)}/commit?${query}`);
  }

  /**
   * The patch for one path in one commit.
   *
   * One path per request rather than the commit's whole patch: a reader who expanded a commit is
   * looking at a list of files, and has asked for none of them yet.
   */
  commitDiff(id: string, hash: string, path: string): Promise<{ diff: WorkspaceCommitDiff }> {
    const query = new URLSearchParams({ hash, path });
    return this.call("GET", `/api/workspace/${encodeURIComponent(id)}/diff?${query}`);
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
    return this.call("POST", `/api/workspace/${encodeURIComponent(id)}/state`, {
      baseRevision,
      operationId: crypto.randomUUID(),
      operation,
    });
  }

  readFile(id: string, path: string): Promise<{ file: WorkspaceFileRead }> {
    const query = new URLSearchParams({ path });
    return this.call("GET", `/api/workspace/${encodeURIComponent(id)}/file?${query}`);
  }

  /** The path a binary-backed document's bytes are fetched from, for the docx renderer. */
  contentPath(id: string, path: string): string {
    const query = new URLSearchParams({ path });
    return `/api/workspace/${encodeURIComponent(id)}/content?${query}`;
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
    { status: "written"; written: WorkspaceFileWritten }
    | { status: "conflict"; conflict: WorkspaceFileConflict }
  > {
    const response = await this.transport.request(
      "POST",
      `/api/workspace/${encodeURIComponent(id)}/file`,
      { body: { path, expectedRevision, text } },
    );
    if (response.status === 409) {
      const payload = JSON.parse(response.body) as { conflict?: WorkspaceFileConflict };
      // A 409 is also how a read-only kind is refused, and that has no conflict body.
      if (payload.conflict) return { status: "conflict", conflict: payload.conflict };
    }
    const written = parse<{ written: WorkspaceFileWritten }>(response.status, response.body);
    return { status: "written", written: written.written };
  }

  /** Follow one workspace's stream. Returns unsubscribe. */
  subscribe(
    id: string,
    onEvent: (event: WorkspaceStreamEvent) => void,
    onError: (reason: string) => void,
  ): () => void {
    return this.transport.subscribe(`/api/workspace/${encodeURIComponent(id)}/stream`, {
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
