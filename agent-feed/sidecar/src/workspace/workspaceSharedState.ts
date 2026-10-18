// What every reader of one workspace sees: which files are open, in what order, and which
// directories are expanded.
//
// Ported from `WorkspaceIDEStateCoordinator`. It stayed shared rather than becoming per-tab because
// the case it was built for has not gone away, only changed shape: it used to be the Mac and the
// phone on one workspace, and it is now two panel surfaces on one sidecar. Opening a file on one
// should show it on the other.
//
// Device-local state is deliberately absent: selection, drafts, zoom and pane sizes belong to the
// reader's own panel storage, and putting them here would make one reader's scroll position
// another reader's problem.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceOperation, WorkspaceSharedState } from "@agentdesk/agent-feed-wire";
import { isStorablePath } from "@/workspace/workspacePaths";

export const SHARED_STATE_VERSION = 1;

/**
 * Bounds, ported unchanged.
 *
 * They exist because every one of these lists is appended to by an unauthenticated client, and an
 * unbounded list is a file that grows until the sidecar cannot load it.
 */
export const MAXIMUM_OPEN_PATHS = 256;
export const MAXIMUM_EXPANDED_DIRECTORY_PATHS = 2048;
export const MAXIMUM_OPERATION_ID_BYTES = 512;
const APPLIED_OPERATION_LIMIT = 512;

export type SharedStateFailureCode = "invalidPath" | "invalidOperation" | "revisionConflict" | "stateLimitExceeded";

export class SharedStateFailure extends Error {
  readonly code: SharedStateFailureCode;
  /** Present on a conflict, so a stale client can resynchronise without a second request. */
  readonly currentRevision?: number;

  constructor(code: SharedStateFailureCode, message: string, currentRevision?: number) {
    super(message);
    this.name = "SharedStateFailure";
    this.code = code;
    this.currentRevision = currentRevision;
  }
}

interface Record_ {
  revision: number;
  orderedOpenPaths: string[];
  expandedDirectoryPaths: string[];
  /** The open path that is only a preview, replaced by the next one. See the wire's `previewPath`. */
  previewPath: string | null;
  /**
   * Operation ids already applied, newest last.
   *
   * This is what makes a retry safe. A client that sends `open` and loses the response retries with
   * the same id; without this it would open the file twice, or worse, conflict with itself.
   */
  appliedOperationIds: string[];
}

interface StoredState {
  version: typeof SHARED_STATE_VERSION;
  records: Record<string, Record_>;
}

function emptyRecord(): Record_ {
  return {
    revision: 0,
    orderedOpenPaths: [],
    expandedDirectoryPaths: [],
    previewPath: null,
    appliedOperationIds: [],
  };
}

function isRecord(value: unknown): value is Record_ {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.revision === "number" &&
    Number.isInteger(record.revision) &&
    Array.isArray(record.orderedOpenPaths) &&
    record.orderedOpenPaths.every((path) => typeof path === "string") &&
    Array.isArray(record.expandedDirectoryPaths) &&
    record.expandedDirectoryPaths.every((path) => typeof path === "string") &&
    Array.isArray(record.appliedOperationIds) &&
    record.appliedOperationIds.every((id) => typeof id === "string") &&
    (record.previewPath === undefined || record.previewPath === null || typeof record.previewPath === "string")
  );
}

function decode(raw: string, path: string): StoredState {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`workspace shared state is not an object: ${path}`);
  }
  const outer = parsed as Record<string, unknown>;
  if (outer.version !== SHARED_STATE_VERSION) {
    throw new Error(`workspace shared state version ${String(outer.version)} is not ${SHARED_STATE_VERSION}: ${path}`);
  }
  if (typeof outer.records !== "object" || outer.records === null) {
    throw new Error(`workspace shared state has no records: ${path}`);
  }
  const records: Record<string, Record_> = {};
  for (const [id, value] of Object.entries(outer.records as Record<string, unknown>)) {
    if (!isRecord(value)) throw new Error(`workspace shared state record is malformed: ${id}`);
    // A record written before previews existed has no field, which is the same fact as null: no
    // tab is a preview. Read as that rather than refused, because refusing is every reader's open
    // tabs gone for a field that has one obvious value.
    records[id] = { ...value, previewPath: value.previewPath ?? null };
  }
  return { version: SHARED_STATE_VERSION, records };
}

function validPath(path: string): string {
  if (!isStorablePath(path)) {
    throw new SharedStateFailure("invalidPath", `not a storable workspace path: ${path}`);
  }
  return path;
}

/**
 * Apply one operation to a record, answering whether anything actually changed.
 *
 * The return value is the reason the revision does not advance on a no-op: opening an already-open
 * file is not a change, and bumping the revision for it would invalidate every other client's base
 * revision for nothing.
 */
function applyOperation(operation: WorkspaceOperation, record: Record_): boolean {
  switch (operation.type) {
    case "open": {
      const path = validPath(operation.path);
      // Opening the preview for real keeps it: it stops being the slot the next preview replaces.
      if (record.previewPath === path) {
        record.previewPath = null;
        return true;
      }
      if (record.orderedOpenPaths.includes(path)) return false;
      if (record.orderedOpenPaths.length >= MAXIMUM_OPEN_PATHS) {
        throw new SharedStateFailure("stateLimitExceeded", "too many open files");
      }
      record.orderedOpenPaths.push(path);
      return true;
    }
    case "preview": {
      const path = validPath(operation.path);
      // Already a tab, kept or previewed: showing it is the reader's own selection, not a change.
      if (record.orderedOpenPaths.includes(path)) return false;
      const slot = record.previewPath === null ? -1 : record.orderedOpenPaths.indexOf(record.previewPath);
      if (slot >= 0) {
        // In place, so stepping through results does not walk the tab along the strip.
        record.orderedOpenPaths[slot] = path;
      } else {
        if (record.orderedOpenPaths.length >= MAXIMUM_OPEN_PATHS) {
          throw new SharedStateFailure("stateLimitExceeded", "too many open files");
        }
        record.orderedOpenPaths.push(path);
      }
      record.previewPath = path;
      return true;
    }
    case "close": {
      const path = validPath(operation.path);
      const before = record.orderedOpenPaths.length;
      record.orderedOpenPaths = record.orderedOpenPaths.filter((open) => open !== path);
      if (record.previewPath === path) record.previewPath = null;
      return record.orderedOpenPaths.length !== before;
    }
    case "reorder": {
      if (operation.orderedPaths.length > MAXIMUM_OPEN_PATHS) {
        throw new SharedStateFailure("stateLimitExceeded", "too many open files");
      }
      const paths = operation.orderedPaths.map(validPath);
      const unique = new Set(paths);
      const current = new Set(record.orderedOpenPaths);
      if (unique.size !== paths.length || unique.size !== current.size || !paths.every((path) => current.has(path))) {
        throw new SharedStateFailure("invalidOperation", "a reorder must be a permutation of the open files");
      }
      if (paths.every((path, index) => path === record.orderedOpenPaths[index])) return false;
      record.orderedOpenPaths = paths;
      return true;
    }
    case "expand": {
      const path = validPath(operation.path);
      if (record.expandedDirectoryPaths.includes(path)) return false;
      if (record.expandedDirectoryPaths.length >= MAXIMUM_EXPANDED_DIRECTORY_PATHS) {
        throw new SharedStateFailure("stateLimitExceeded", "too many expanded directories");
      }
      record.expandedDirectoryPaths.push(path);
      return true;
    }
    case "collapse": {
      const path = validPath(operation.path);
      const before = record.expandedDirectoryPaths.length;
      record.expandedDirectoryPaths = record.expandedDirectoryPaths.filter((open) => open !== path);
      return record.expandedDirectoryPaths.length !== before;
    }
  }
}

export class WorkspaceSharedStateStore {
  private state: StoredState = { version: SHARED_STATE_VERSION, records: {} };
  private mutationTail: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(state: WorkspaceSharedState) => void>();
  readonly ready: Promise<void>;

  constructor(private readonly path: string) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.state = decode(raw, this.path);
  }

  snapshot(workspaceId: string): WorkspaceSharedState {
    return this.project(workspaceId, this.state.records[workspaceId] ?? emptyRecord());
  }

  subscribe(listener: (state: WorkspaceSharedState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Apply one operation, serialised against every other.
   *
   * Serialised because the read-modify-persist below is not atomic on its own: two concurrent
   * requests would both read revision N, both write N+1, and one would be lost with no error
   * anywhere. The tail is the same shape `BotStore` uses for the same reason.
   */
  async apply(
    workspaceId: string,
    baseRevision: number,
    operationId: string,
    operation: WorkspaceOperation,
  ): Promise<WorkspaceSharedState> {
    const run = this.mutationTail.then(
      () => this.applyLocked(workspaceId, baseRevision, operationId, operation),
      () => this.applyLocked(workspaceId, baseRevision, operationId, operation),
    );
    // Swallowed here and not at the call site: the tail exists to order the next mutation, and a
    // rejection stored in it would reject every mutation queued behind this one.
    this.mutationTail = run.catch(() => {});
    return run;
  }

  private async applyLocked(
    workspaceId: string,
    baseRevision: number,
    operationId: string,
    operation: WorkspaceOperation,
  ): Promise<WorkspaceSharedState> {
    await this.ready;
    if (operationId === "" || Buffer.byteLength(operationId, "utf8") > MAXIMUM_OPERATION_ID_BYTES) {
      throw new SharedStateFailure("invalidOperation", "an operation id is required");
    }
    const stored = this.state.records[workspaceId] ?? emptyRecord();
    // Copied deeply enough that an operation which throws halfway leaves the stored record as it
    // was: `preview` writes into the open list in place.
    const record = { ...stored, orderedOpenPaths: [...stored.orderedOpenPaths] };
    if (record.appliedOperationIds.includes(operationId)) {
      return this.project(workspaceId, record);
    }
    if (record.revision !== baseRevision) {
      throw new SharedStateFailure(
        "revisionConflict",
        `workspace state moved to revision ${record.revision}`,
        record.revision,
      );
    }

    const changed = applyOperation(operation, record);
    if (changed) record.revision += 1;
    record.appliedOperationIds = [...record.appliedOperationIds, operationId].slice(-APPLIED_OPERATION_LIMIT);

    this.state = {
      version: SHARED_STATE_VERSION,
      records: { ...this.state.records, [workspaceId]: record },
    };
    await this.persist();

    const projected = this.project(workspaceId, record);
    if (changed) {
      for (const listener of this.listeners) listener(projected);
    }
    return projected;
  }

  private project(workspaceId: string, record: Record_): WorkspaceSharedState {
    return {
      workspaceId,
      revision: record.revision,
      orderedOpenPaths: [...record.orderedOpenPaths],
      expandedDirectoryPaths: [...record.expandedDirectoryPaths],
      previewPath: record.previewPath,
    };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.workspace-state-${crypto.randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
