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
 * Ported from `WorkspaceKit.WorkspaceFileKind`. `docx`, `pdf` and `notebook` are read-only because
 * the panel renders them from a parsed model rather than from their bytes, so an edit would have
 * nowhere to go. `docx` and `pdf` are binary-backed: a read answers without their text, and the
 * bytes come from the content route.
 */
export type WorkspaceFileKind = "text" | "markdown" | "html" | "notebook" | "docx" | "pdf";

export type WorkspaceFileMode = "edit" | "preview";

/**
 * One entry in a directory listing. Directories sort first, then by locale-aware name.
 *
 * `modifiedAt` is the filesystem's own mtime for the entry, in milliseconds since the epoch. It is
 * here because a reader who wants "what did I touch lately" cannot be answered without it, and
 * because a browser cannot stat anything: whatever reads this decides how to order it and how to
 * say it, rather than being handed a formatted string to display.
 */
export interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  modifiedAt: number;
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
  /** The entry's mtime in milliseconds since the epoch, for ordering by how recently it changed. */
  modifiedAt: number;
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
  /**
   * The open path that is only being looked at, or null.
   *
   * A search result opens here rather than as a tab of its own: stepping through twenty results
   * would otherwise leave twenty tabs, on every reader's screen. The next preview replaces it in
   * place, and opening it for real -- an `open`, or an edit -- keeps it. VS Code's preview tab.
   */
  previewPath: string | null;
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
  | { type: "preview"; path: string }
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
  /** Null for a binary-backed kind (`docx`, `pdf`), whose bytes are fetched from the content route. */
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
 * One folder the reader could choose as a workspace root.
 *
 * Named apart from `WorkspaceDirectoryEntry` above, which is a different thing with a different
 * shape: that one lists what is INSIDE a registered workspace, files included, with paths relative
 * to its root. This one lists candidate roots, directories only, by absolute path.
 */
export interface WorkspaceBrowseEntry {
  name: string;
  path: string;
}

export interface WorkspaceBrowseListing {
  path: string;
  /** Null at the confinement root, so the panel knows whether to offer a way up. */
  parent: string | null;
  entries: WorkspaceBrowseEntry[];
}

/**
 * What a folder creation leaves behind: the listing of the folder that now exists.
 *
 * The listing rather than the path, so the panel does not have to assemble the answer it is about
 * to browse -- and because the sidecar resolved the name against what is really there, so the path
 * on screen is the resolved one rather than the one the reader typed.
 */
export interface WorkspaceFolderCreated {
  listing: WorkspaceBrowseListing;
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
  // The folder picker's own: a name that is already taken, which is the answer a reader gets most
  // often and the one a generic "invalid path" would say nothing useful about.
  | "nameTaken"
  | "revisionConflict"
  | "invalidOperation"
  | "stateLimitExceeded"
  // Search: no `rg` on this machine, too many searches running, a regex or glob rg refused.
  | "searchUnavailable"
  | "searchBusy"
  | "invalidQuery"
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

/**
 * One commit in the history the status bar pops up.
 *
 * The full hash travels as well as the short one because every follow-up request names a commit,
 * and an abbreviation is only unique until the repository grows. The short one is what the reader
 * sees, so it is git's own abbreviation rather than a slice taken here: how many characters that
 * takes is a property of the repository, and git is the only one that knows it.
 */
export interface WorkspaceCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** Committer date, in seconds since the epoch. The panel decides how to say it. */
  committedAt: number;
  /** A merge has more than one parent, and its file list is read against the first. */
  parentCount: number;
}

/**
 * One path a commit touched, with the counts git reports for it.
 *
 * `additions` and `deletions` are null for a binary file, which `--numstat` reports as `-`: zero
 * would be a lie about a file that changed, and the panel says "binary" where it would say counts.
 */
export interface WorkspaceCommitFile {
  path: string;
  /** The `--name-status` letter: `A`, `M`, `D`, `R`, `C` or `T`, with its similarity score cut. */
  status: string;
  additions: number | null;
  deletions: number | null;
  /** Where a renamed or copied file came from, so the row can say what moved. */
  previousPath: string | null;
}

export interface WorkspaceCommitDetail {
  workspaceId: string;
  hash: string;
  /**
   * The message under the subject, as the author wrote it, and "" for a commit that has none.
   *
   * The subject is not repeated here: it is on the commit itself, which is what a log row draws.
   * This is the part a one-line row cannot carry, which on this repository is most of the reason
   * the commit was worth reading.
   */
  body: string;
  files: WorkspaceCommitFile[];
}

/**
 * The patch for one path in one commit, against the commit before it.
 *
 * One path at a time rather than the whole commit: a refactor's patch is megabytes, and a reader
 * who expanded a commit to see its files has not asked for every one of them yet.
 */
export interface WorkspaceCommitDiff {
  workspaceId: string;
  hash: string;
  path: string;
  patch: string;
  /** True when the patch was cut at the sidecar's ceiling, so the panel can say so rather than
   * showing a diff that ends mid-hunk as though that were the end of it. */
  truncated: boolean;
}

/**
 * `GET /api/workspaces/:id/change?path=`: one path's uncommitted change against `HEAD`.
 *
 * Staged and unstaged together, because the source-control list files a path under whichever it
 * is and a reader opening it wants to see what it would take to commit, not one half of it. A file
 * git does not track yet arrives whole, as added.
 */
export interface WorkspaceChangeDiff {
  workspaceId: string;
  path: string;
  patch: string;
  truncated: boolean;
}

/**
 * `GET /api/workspaces/:id/files`: every file quick open can offer, relative to the root.
 *
 * The whole list, once per opening of the picker, and matched in the panel: a fuzzy match has to
 * score every candidate on every keystroke, which is cheap on 20,000 strings in hand and a round
 * trip per character otherwise. `truncated` says the list was cut at the sidecar's cap, so a file
 * that is not offered is explained rather than silently missing.
 */
export interface WorkspaceFileList {
  workspaceId: string;
  files: string[];
  truncated: boolean;
}

/** How a text search reads its query. Every field defaults to off. */
export interface WorkspaceSearchOptions {
  /** Off means smart case: case-insensitive unless the query holds a capital. */
  matchCase: boolean;
  wholeWord: boolean;
  /** Off means literal words, found in any order on one line; `"quoted"` keeps a phrase whole. */
  regex: boolean;
  /** Globs, as VS Code's "files to include" and "files to exclude" take them. */
  include: string[];
  exclude: string[];
}

/** One matching line. `ranges` are `[start, end)` indices into `preview`, which may be trimmed. */
export interface WorkspaceSearchMatch {
  line: number;
  preview: string;
  ranges: Array<[number, number]>;
  /**
   * What to add to a `preview` index to get the index in the whole line: zero for a line shown
   * whole, and for a trimmed one the characters cut from its start, less the "…" standing for them.
   * It is what lets a result select its match in the file rather than only reach the line.
   */
  previewOffset: number;
}

export interface WorkspaceSearchFile {
  path: string;
  matches: WorkspaceSearchMatch[];
}

/**
 * `GET /api/workspaces/:id/search?q=...`: the lines that match, grouped by file.
 *
 * Whole rather than streamed. A streamed answer would ride `EventSource`, which reconnects when the
 * server ends a stream -- and a reconnect is the same search run again. Measured 2026-09-30, one
 * query over a 17,600-file folder answers in about half a second, so the reader loses little by
 * waiting for the lot, and a search they have typed past is cancelled by aborting its request.
 */
export interface WorkspaceSearchResult {
  workspaceId: string;
  query: string;
  files: WorkspaceSearchFile[];
  matchCount: number;
  /** The match cap was reached, so there are more than `matchCount`. */
  truncated: boolean;
}
