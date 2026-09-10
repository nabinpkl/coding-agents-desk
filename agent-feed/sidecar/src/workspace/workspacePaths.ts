// Turning a path a client sent into a path this process will open, or refusing it.
//
// This is the security boundary of the workspace IDE and the reason it is its own file. The Swift
// it replaces (`WorkspaceFilePOSIX`) walked the path with `openat` from a descriptor for the
// workspace root, with `O_NOFOLLOW` on every component, so a client string was never interpreted as
// a host path and a symlink could not leave the root. Node has no `openat`, so the walk here is by
// path with an `lstat` per component and `O_NOFOLLOW` on the leaf. A symlink is still refused at
// every component; what is lost is atomicity between the check and the open, which needs an
// attacker who can already create symlinks inside a registered root, mid-request (ADR-0115).
//
// The sidecar has no authentication -- its boundary is the bind address plus WireGuard -- so this
// validation is the only thing between the tailnet and the filesystem. It is tested before anything
// calls it.

import { constants, promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * Why a path or a file operation was refused.
 *
 * One-for-one with the Swift `WorkspaceFileServiceFailure`, so the taxonomy the surface already
 * knows how to render survives the port instead of collapsing into strings.
 */
export type WorkspaceFailureCode =
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
  | "writeFailed";

const MESSAGES: Record<WorkspaceFailureCode, string> = {
  workspaceUnavailable: "Workspace is unavailable.",
  invalidPath: "The requested path is invalid.",
  notFound: "The requested item was not found.",
  forbidden: "Access to this path is not permitted.",
  notDirectory: "The requested path is not a directory.",
  notFile: "The requested path is not a regular file.",
  readOnly: "This document is read-only.",
  binary: "Binary files cannot be opened here.",
  invalidUtf8: "This file is not valid UTF-8 text.",
  tooLarge: "This file exceeds the supported size.",
  writeFailed: "The file could not be saved.",
};

export class WorkspaceFailure extends Error {
  readonly code: WorkspaceFailureCode;

  constructor(code: WorkspaceFailureCode) {
    super(MESSAGES[code]);
    this.name = "WorkspaceFailure";
    this.code = code;
  }
}

/**
 * The longest path the state store will hold, and therefore the longest one worth validating.
 *
 * Ported from `WorkspaceIDEStateCoordinator.maximumPathBytes`. It bounds what a client can make the
 * process allocate before any filesystem call happens.
 */
export const MAXIMUM_PATH_BYTES = 4 * 1024;

/**
 * Split a client path into components, or refuse it.
 *
 * The refusals are the Swift's, and each one is load-bearing:
 *
 * - an absolute path, because the root is ours to choose, not the caller's;
 * - `.` and `..`, because the walk below never resolves them and a `..` that reached the filesystem
 *   would leave the root;
 * - an empty component, because `a//b` and `a/b` would name one file by two paths, and the shared
 *   state stores paths as identity;
 * - an embedded NUL, because the C string conversion at the syscall boundary truncates at it, so
 *   the string validated and the string opened would differ.
 *
 * `allowRoot` is what separates a directory listing (the root is a legitimate target) from a file
 * read (it is not).
 */
export function pathComponents(path: string, { allowRoot }: { allowRoot: boolean }): string[] {
  if (path === "") {
    if (!allowRoot) throw new WorkspaceFailure("invalidPath");
    return [];
  }
  if (path.startsWith("/")) throw new WorkspaceFailure("invalidPath");
  if (Buffer.byteLength(path, "utf8") > MAXIMUM_PATH_BYTES) {
    throw new WorkspaceFailure("invalidPath");
  }
  const parts = path.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || part.includes("\0")) {
      throw new WorkspaceFailure("invalidPath");
    }
  }
  return parts;
}

/**
 * Whether a path is one the shared state may store.
 *
 * The same rules as `pathComponents` without the root case, expressed as a predicate because the
 * state coordinator validates a list of paths and wants to refuse the list rather than throw on its
 * first bad element.
 */
export function isStorablePath(path: string): boolean {
  try {
    pathComponents(path, { allowRoot: false });
    return true;
  } catch {
    return false;
  }
}

/** Map an errno to the refusal it means, matching the Swift's `failure(for:)`. */
function failureForErrno(error: unknown): WorkspaceFailure {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case "ENOENT":
      return new WorkspaceFailure("notFound");
    case "ELOOP":
    case "EACCES":
    case "EPERM":
      return new WorkspaceFailure("forbidden");
    case "ENOTDIR":
      return new WorkspaceFailure("notDirectory");
    default:
      return new WorkspaceFailure("notFound");
  }
}

/**
 * Walk from the root through each component, refusing a symlink or a non-directory on the way.
 *
 * `lstat` rather than `stat` is the whole point: `stat` follows the link and would report the
 * target's kind, so a symlinked directory pointing outside the root would pass as a directory. A
 * link anywhere in the path is `forbidden`, which is a different sentence from "not a directory"
 * and the one a reader needs.
 */
async function walkDirectory(root: string, components: string[]): Promise<string> {
  let current = root;
  let status;
  try {
    status = await fs.lstat(current);
  } catch (error) {
    throw failureForErrno(error);
  }
  if (status.isSymbolicLink()) throw new WorkspaceFailure("forbidden");
  if (!status.isDirectory()) throw new WorkspaceFailure("notDirectory");

  for (const component of components) {
    current = join(current, component);
    try {
      status = await fs.lstat(current);
    } catch (error) {
      throw failureForErrno(error);
    }
    if (status.isSymbolicLink()) throw new WorkspaceFailure("forbidden");
    if (!status.isDirectory()) throw new WorkspaceFailure("notDirectory");
  }
  return current;
}

/** The absolute path of a directory inside `root`, verified symlink-free at every component. */
export async function resolveDirectory(root: string, path: string): Promise<string> {
  return walkDirectory(root, pathComponents(path, { allowRoot: true }));
}

export interface ResolvedFile {
  /** The directory holding it, which is where an atomic write puts its temporary file. */
  directory: string;
  name: string;
  absolute: string;
}

/**
 * The absolute path of a regular file inside `root`, verified symlink-free at every component
 * including the leaf.
 *
 * The leaf is checked with `lstat` here and opened with `O_NOFOLLOW` by the caller. Both, rather
 * than either: `lstat` gives the refusal its right name, and `O_NOFOLLOW` is what actually holds if
 * the entry is replaced between the two.
 */
export async function resolveFile(root: string, path: string): Promise<ResolvedFile> {
  const components = pathComponents(path, { allowRoot: false });
  const name = components[components.length - 1]!;
  const directory = await walkDirectory(root, components.slice(0, -1));
  const absolute = join(directory, name);
  let status;
  try {
    status = await fs.lstat(absolute);
  } catch (error) {
    throw failureForErrno(error);
  }
  if (status.isSymbolicLink()) throw new WorkspaceFailure("forbidden");
  if (!status.isFile()) throw new WorkspaceFailure("notFile");
  return { directory, name, absolute };
}

/**
 * `O_NOFOLLOW` on the leaf open, so a link swapped in after the `lstat` fails rather than opens.
 *
 * No `O_CLOEXEC`: libuv already opens every descriptor it creates close-on-exec, and the constant
 * is absent from Node's own typings, so naming it here would be a cast for no behaviour.
 */
export const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
