// The workspace IDE contract: what the sidecar answers, and what the panel asks it to do.
//
// This replaces `packages/WorkspaceIDE/Web/src/projection.ts` and the Swift `WorkspaceIDEProjection`
// it mirrored. That pair existed because the same model was written on both sides of a WKWebView
// message bridge with abbreviated CodingKeys (`w`, `r`, `o`, `e`) on the Swift half, which made a
// drift silent. Both ends are TypeScript now, so there is one spelling and nothing to mirror.

/** One registered project root the IDE can browse. */
export interface WorkspaceSummary {
  id: string;
  name: string;
  root: string;
}

/**
 * What a file is, which decides whether it can be edited and how it is shown.
 *
 * Ported from `WorkspaceKit.WorkspaceFileKind`. `docx` and `notebook` are read-only because the
 * panel renders them from a parsed model rather than from their bytes, so an edit would have
 * nowhere to go.
 */
export type WorkspaceFileKind = "text" | "markdown" | "html" | "notebook" | "docx";

export type WorkspaceFileMode = "edit" | "preview";

/** One entry in a directory listing. Directories sort first, then by locale-aware name. */
export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/**
 * A node in the tree the sidebar draws.
 *
 * `children` is present only for an expanded directory: the sidecar sends the subtree it has,
 * rather than the panel asking per directory, so one projection paints the whole visible tree.
 */
export interface WorkspaceTreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  expanded: boolean;
  gitStatus: string | null;
  children: WorkspaceTreeNode[];
}

/** One path git has something to say about, as `git status --porcelain` reports it. */
export interface WorkspaceGitEntry {
  relativePath: string;
  indexStatus: string | null;
  workTreeStatus: string | null;
}

export interface WorkspaceGitStatus {
  workspaceId: string;
  branch: string | null;
  entries: WorkspaceGitEntry[];
}

/**
 * The state every reader of one workspace shares: which files are open, in what order, and which
 * directories are expanded.
 *
 * Ported from `WorkspaceIDESharedState`. It stays shared rather than becoming per-tab because two
 * panel surfaces on one sidecar are the same case the Mac and the phone used to be: opening a file
 * on one should show it on the other. Device-local choices -- selection, drafts, zoom, pane sizes --
 * are deliberately not here; they live in panel storage.
 */
export interface WorkspaceSharedState {
  workspaceId: string;
  revision: number;
  orderedOpenPaths: string[];
  expandedDirectoryPaths: string[];
}

/**
 * A change to the shared state, applied against a base revision.
 *
 * Every mutation carries an `operationId` so a retry after a dropped response is a no-op rather
 * than a second open, and a `baseRevision` so a client working from a stale snapshot is told to
 * refresh instead of overwriting someone else's change.
 */
export type WorkspaceOperation =
  | { type: "open"; path: string }
  | { type: "close"; path: string }
  | { type: "reorder"; orderedPaths: string[] }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string };

export interface WorkspaceOperationRequest {
  baseRevision: number;
  operationId: string;
  operation: WorkspaceOperation;
}

/** A file's content hash. A write states the revision it edited, and is refused if it moved. */
export type WorkspaceFileRevision = string;

export interface WorkspaceFileRead {
  workspaceId: string;
  path: string;
  kind: WorkspaceFileKind;
  revision: WorkspaceFileRevision;
  /** Null for a binary-backed kind (`docx`), whose bytes are fetched from the content route. */
  text: string | null;
}

export interface WorkspaceFileWritten {
  workspaceId: string;
  path: string;
  revision: WorkspaceFileRevision;
}

/**
 * A refused write: the file changed underneath the edit.
 *
 * The panel resolves it by asking for the host's version or keeping its own, which is why the
 * current revision travels with the refusal rather than forcing a second read to discover it.
 */
export interface WorkspaceFileConflict {
  workspaceId: string;
  path: string;
  currentRevision: WorkspaceFileRevision;
}

/**
 * Why an operation was refused.
 *
 * Ported one-for-one from `WorkspaceFileServiceFailure`, including the distinction the Swift kept:
 * an unknown workspace and an unknown file share `notFound` but carry different messages, so a
 * reader can tell them apart without the wire growing a case.
 */
export type WorkspaceErrorCode =
  | "workspaceUnavailable"
  | "invalidPath"
  | "notFound"
  | "forbidden"
  | "notDirectory"
  | "notFile"
  | "readOnly"
  | "binary"
  | "invalidUtf8"
  | "tooLarge"
  | "writeFailed"
  | "revisionConflict"
  | "invalidOperation"
  | "stateLimitExceeded"
  // The sidecar got something wrong, rather than the caller. Kept distinct so a bug here does
  // not spend a week reading as a bad request.
  | "internal";

export interface WorkspaceError {
  code: WorkspaceErrorCode;
  message: string;
  workspaceId: string | null;
  path: string | null;
}

/**
 * What the IDE stream pushes.
 *
 * One stream per workspace rather than one per concern: the tree, the git status and the shared
 * state all change together when a file lands on disk, and three streams would be three of the six
 * connections a browser gives an origin (see AGENTS.md on HTTP/2 and the panel's stream budget).
 */
export type WorkspaceStreamEvent =
  | { type: "workspaces"; workspaces: WorkspaceSummary[] }
  | { type: "sharedState"; state: WorkspaceSharedState }
  | { type: "tree"; workspaceId: string; tree: WorkspaceTreeNode[] }
  | { type: "git"; status: WorkspaceGitStatus }
  | { type: "changed"; workspaceId: string; changedPaths: string[] };
