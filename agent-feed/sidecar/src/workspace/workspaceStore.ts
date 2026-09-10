// The roster of project roots the IDE can browse.
//
// Ported from the host's `WorkspaceStore`, minus everything that was about a Mac window: the mode,
// the pinned bars, the editor frame and the Desktop assignment all belonged to the AppKit shell,
// and Desktop placement has one authority already (ADR-0092, ADR-0115). What is left is the part
// the IDE actually reads: an id that survives a rename, a display name, and a root.

import { mkdir, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorkspaceSummary } from "@agentdesk/agent-feed-wire";

export const WORKSPACE_STORE_VERSION = 1;

interface StoredWorkspaces {
  version: typeof WORKSPACE_STORE_VERSION;
  workspaces: WorkspaceSummary[];
}

export class WorkspaceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceStoreError";
  }
}

function isSummary(value: unknown): value is WorkspaceSummary {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && record.id !== ""
    && typeof record.name === "string" && record.name !== ""
    && typeof record.root === "string" && record.root.startsWith("/");
}

/**
 * Decode the file, or refuse it.
 *
 * There is no tolerant decode and no per-field default: this is pre-v0, so the shape on disk is the
 * shape in this file and a mismatch is a store written by something else. Silently rewriting it as
 * an empty roster would lose a reader's registered projects without saying so.
 */
function decode(raw: string, path: string): StoredWorkspaces {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WorkspaceStoreError(`workspace store is not JSON: ${path}: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new WorkspaceStoreError(`workspace store is not an object: ${path}`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== WORKSPACE_STORE_VERSION) {
    throw new WorkspaceStoreError(
      `workspace store version ${String(record.version)} is not ${WORKSPACE_STORE_VERSION}: ${path}`,
    );
  }
  if (!Array.isArray(record.workspaces) || !record.workspaces.every(isSummary)) {
    throw new WorkspaceStoreError(`workspace store holds a malformed workspace: ${path}`);
  }
  return { version: WORKSPACE_STORE_VERSION, workspaces: record.workspaces };
}

/**
 * A root that is safe to browse right now.
 *
 * Stricter than what the store will hold, and deliberately so: a registered root can disappear or
 * be replaced by a symlink after it was written, and the check that matters is the one at
 * registration. The symlink refusal is the same one `workspacePaths` makes on every component; a
 * symlinked root would mean the whole roster pointed somewhere the reader did not choose.
 */
export async function validateRoot(root: string): Promise<string> {
  const absolute = resolve(root);
  if (!absolute.startsWith("/")) throw new WorkspaceStoreError(`workspace root is not absolute: ${root}`);
  let status;
  try {
    status = await lstat(absolute);
  } catch {
    throw new WorkspaceStoreError(`workspace root does not exist: ${absolute}`);
  }
  if (status.isSymbolicLink()) {
    throw new WorkspaceStoreError(`workspace root is a symbolic link: ${absolute}`);
  }
  if (!status.isDirectory()) {
    throw new WorkspaceStoreError(`workspace root is not a directory: ${absolute}`);
  }
  return absolute;
}

/**
 * The roster, persisted, with the current value held in memory.
 *
 * Reads are synchronous against that value because the tree, the git status and every projection
 * need it on the way through; only mutation touches the disk. `ready` is what a caller awaits once
 * at startup rather than on every read.
 */
export class WorkspaceStore {
  private workspaces: WorkspaceSummary[] = [];
  private readonly listeners = new Set<(workspaces: WorkspaceSummary[]) => void>();
  readonly ready: Promise<void>;

  constructor(private readonly path: string) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      // A store that has never been written is an empty roster, which is a first run rather than a
      // failure. Anything else -- unreadable, a directory, a permission error -- is not.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new WorkspaceStoreError(`workspace store is unreadable: ${this.path}: ${String(error)}`);
    }
    this.workspaces = decode(raw, this.path).workspaces;
  }

  list(): WorkspaceSummary[] {
    return [...this.workspaces];
  }

  get(id: string): WorkspaceSummary | undefined {
    return this.workspaces.find((workspace) => workspace.id === id);
  }

  /** Subscribe to roster changes. Returns the unsubscribe, which callers must hold. */
  subscribe(listener: (workspaces: WorkspaceSummary[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async add(root: string, name?: string): Promise<WorkspaceSummary> {
    const absolute = await validateRoot(root);
    const existing = this.workspaces.find((workspace) => workspace.root === absolute);
    if (existing) return existing;
    const workspace: WorkspaceSummary = {
      id: crypto.randomUUID(),
      name: name?.trim() || absolute.split("/").filter(Boolean).pop() || absolute,
      root: absolute,
    };
    await this.commit([...this.workspaces, workspace]);
    return workspace;
  }

  async remove(id: string): Promise<void> {
    const next = this.workspaces.filter((workspace) => workspace.id !== id);
    if (next.length === this.workspaces.length) {
      throw new WorkspaceStoreError(`no such workspace: ${id}`);
    }
    await this.commit(next);
  }

  async rename(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === "") throw new WorkspaceStoreError("a workspace name cannot be empty");
    if (!this.get(id)) throw new WorkspaceStoreError(`no such workspace: ${id}`);
    await this.commit(
      this.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, name: trimmed } : workspace
      ),
    );
  }

  /**
   * Reorder the roster, refusing anything that is not a permutation of it.
   *
   * A partial list would silently drop the workspaces it omitted, which is the kind of data loss
   * that looks like a rendering bug for a week.
   */
  async reorder(ids: string[]): Promise<void> {
    const known = new Set(this.workspaces.map((workspace) => workspace.id));
    if (ids.length !== known.size || new Set(ids).size !== ids.length
      || !ids.every((id) => known.has(id))) {
      throw new WorkspaceStoreError("a reorder must be a permutation of the current roster");
    }
    await this.commit(ids.map((id) => this.get(id)!));
  }

  private async commit(workspaces: WorkspaceSummary[]): Promise<void> {
    const snapshot: StoredWorkspaces = { version: WORKSPACE_STORE_VERSION, workspaces };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.workspaces-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new WorkspaceStoreError(`workspace store write failed: ${this.path}: ${String(error)}`);
    }
    this.workspaces = workspaces;
    for (const listener of this.listeners) listener(this.list());
  }
}
