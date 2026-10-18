// Reading, listing and writing files inside a registered workspace root.
//
// Ported from `WorkspaceFileService.swift`. Every filesystem call here goes through
// `workspacePaths.ts`, which is what keeps a client string from becoming a host path; nothing in
// this file resolves a path itself.

import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { join } from "node:path";
import type { WorkspaceDirectoryEntry, WorkspaceFileKind, WorkspaceFileRevision } from "@agentdesk/agent-feed-wire";
import { READ_FLAGS, resolveDirectory, resolveFile, WorkspaceFailure } from "@/workspace/workspacePaths";

/**
 * What a file is, from its extension alone.
 *
 * Ported from `WorkspaceKit.WorkspaceFileKind`. Extension rather than content sniffing because the
 * answer decides which editor the panel mounts, and that has to be known before the bytes arrive.
 */
export function fileKind(path: string): WorkspaceFileKind {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  const extension = dot > slash ? path.slice(dot + 1).toLowerCase() : "";
  switch (extension) {
    case "docx":
      return "docx";
    case "pdf":
      return "pdf";
    case "html":
    case "htm":
      return "html";
    case "md":
    case "markdown":
      return "markdown";
    case "ipynb":
      return "notebook";
    default:
      return "text";
  }
}

/**
 * Whether the panel may edit this kind.
 *
 * `docx`, `pdf` and `notebook` are rendered from a parsed model rather than from their bytes, so an
 * edit in the panel has nowhere to be written back to. Refusing the write is the loud version of
 * that.
 */
export function isReadOnlyKind(kind: WorkspaceFileKind): boolean {
  return kind === "notebook" || isBinaryKind(kind);
}

/**
 * Whether this kind is read as bytes rather than text: a read answers with its revision and no
 * text, and the panel's renderer fetches the bytes from the content route.
 */
export function isBinaryKind(kind: WorkspaceFileKind): boolean {
  return kind === "docx" || kind === "pdf";
}

/** A file's identity for conflict detection: the sha256 of exactly the bytes on disk. */
export function revisionOf(bytes: Uint8Array): WorkspaceFileRevision {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * How many entries are stat'ed at once.
 *
 * `readdir` names entries without stat'ing them, so a listing that carries dates pays one stat per
 * entry, and this bounds how many are in flight. Measured here on 2026-10-03, warm, over
 * directories of 50, 619 and 5,000 entries: 64 at a time took 42ms against 86ms for all at once and
 * 84ms one at a time on the 5,000, and the three are indistinguishable below a thousand. Node runs
 * fs work on a four-thread pool, so this is how many jobs are worth queueing at it rather than how
 * many descriptors to hold.
 */
const STAT_BATCH = 64;

/** When an entry last changed, or 0 when there is nothing to say. */
async function modifiedAtOf(directory: string, name: string): Promise<number> {
  try {
    return (await fs.stat(join(directory, name))).mtimeMs;
  } catch {
    // Gone, or unreadable, between the two calls. 0 rather than a failed listing, the same as the
    // empty node a directory that disappears mid-read produces. A stamp only ever orders a row and
    // never decides what may be opened -- the open resolves the path again, with `O_NOFOLLOW` -- so
    // a wrong one costs a row in the wrong place and nothing else.
    return 0;
  }
}

/**
 * One directory, listed.
 *
 * Symlinks are omitted rather than refused, which is what the Swift did by letting a component's
 * `O_NOFOLLOW` open fail and continuing. A listing is a view of what can be opened, and an entry
 * that would be refused on open has no business being offered.
 *
 * Sorted directories first, then by `localeCompare` with numeric collation, so `file2` precedes
 * `file10` the way `localizedStandardCompare` did. That is the order the tree draws by default and
 * it is decided HERE, once: a reader who asks for another order reorders what this returns rather
 * than getting a second comparator to disagree with this one.
 */
export async function listDirectory(root: string, path: string): Promise<WorkspaceDirectoryEntry[]> {
  const directory = await resolveDirectory(root, path);
  const children = await fs.readdir(directory, { withFileTypes: true });
  const listed = children.filter((child) => !child.isSymbolicLink() && (child.isDirectory() || child.isFile()));
  const stamps: number[] = [];
  for (let at = 0; at < listed.length; at += STAT_BATCH) {
    stamps.push(
      ...(await Promise.all(listed.slice(at, at + STAT_BATCH).map((child) => modifiedAtOf(directory, child.name)))),
    );
  }
  const entries = listed.map((child, at): WorkspaceDirectoryEntry => ({
    name: child.name,
    path: path === "" ? child.name : `${path}/${child.name}`,
    isDirectory: child.isDirectory(),
    modifiedAt: stamps[at] ?? 0,
  }));
  return entries.sort((left, right) => {
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    const compared = left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    return compared === 0 ? (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) : compared;
  });
}

/**
 * Read a file's bytes, refusing one larger than the cap before reading any of it.
 *
 * The size is taken from the open descriptor's `fstat`, not from a prior `stat` of the path, so the
 * file measured is the file read.
 */
async function readBytes(absolute: string, maxBytes: number): Promise<Uint8Array> {
  let handle;
  try {
    handle = await fs.open(absolute, READ_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EACCES" || code === "EPERM") {
      throw new WorkspaceFailure("forbidden");
    }
    if (code === "ENOENT") throw new WorkspaceFailure("notFound");
    throw new WorkspaceFailure("notFound");
  }
  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new WorkspaceFailure("notFile");
    if (status.size > maxBytes) throw new WorkspaceFailure("tooLarge");
    const bytes = new Uint8Array(await handle.readFile());
    // Checked again after the read, not only before it: a file that grew between the `fstat` and
    // the last byte would otherwise be returned over the cap. The Swift enforced the same bound
    // inside its read loop, so it also refused to allocate the excess; this refuses after
    // allocating it, which needs someone who can already write inside a registered root.
    if (bytes.byteLength > maxBytes) throw new WorkspaceFailure("tooLarge");
    return bytes;
  } finally {
    await handle.close();
  }
}

export interface WorkspaceTextFile {
  text: string;
  revision: WorkspaceFileRevision;
}

export interface WorkspaceDocumentFile {
  bytes: Uint8Array;
  revision: WorkspaceFileRevision;
}

/**
 * Read a file as text, or refuse it as binary.
 *
 * The NUL check comes before the decode because it is the cheaper and more honest of the two
 * answers: a file with a NUL in it is binary, and telling the reader "not valid UTF-8" about a PNG
 * describes the decoder rather than the file.
 */
export async function readTextFile(root: string, path: string, maxBytes: number): Promise<WorkspaceTextFile> {
  const file = await resolveFile(root, path);
  const bytes = await readBytes(file.absolute, maxBytes);
  if (bytes.includes(0)) throw new WorkspaceFailure("binary");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new WorkspaceFailure("invalidUtf8");
  }
  return { text, revision: revisionOf(bytes) };
}

/** Read a file as opaque bytes, which is how `docx` and `pdf` reach the panel's renderers. */
export async function readDocumentFile(root: string, path: string, maxBytes: number): Promise<WorkspaceDocumentFile> {
  const file = await resolveFile(root, path);
  const bytes = await readBytes(file.absolute, maxBytes);
  return { bytes, revision: revisionOf(bytes) };
}

export type WorkspaceWriteOutcome =
  | { status: "written"; revision: WorkspaceFileRevision }
  | { status: "conflict"; currentRevision: WorkspaceFileRevision };

/**
 * Replace a file's contents, but only if it still holds what the editor was editing.
 *
 * The revision check is read-then-compare rather than a lock: two writers racing means the second
 * one's read sees the first one's bytes and conflicts, which is the outcome a reader can act on.
 * A conflict is a return value rather than a throw because it is a normal result of two people
 * editing, not a failure of the request.
 */
export async function writeTextFile(
  root: string,
  path: string,
  expectedRevision: WorkspaceFileRevision,
  text: string,
  maxBytes: number,
): Promise<WorkspaceWriteOutcome> {
  if (isReadOnlyKind(fileKind(path))) throw new WorkspaceFailure("readOnly");
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maxBytes) throw new WorkspaceFailure("tooLarge");
  if (bytes.includes(0)) throw new WorkspaceFailure("binary");

  const file = await resolveFile(root, path);
  const current = await readBytes(file.absolute, maxBytes);
  const currentRevision = revisionOf(current);
  if (currentRevision !== expectedRevision) {
    return { status: "conflict", currentRevision };
  }
  await writeAtomically(file.directory, file.name, bytes);
  return { status: "written", revision: revisionOf(bytes) };
}

/**
 * Write through a temporary file in the same directory, then rename over the target.
 *
 * Same directory so the rename is within one filesystem and therefore atomic; `O_EXCL` so a
 * temporary name that somehow exists is an error rather than a file someone else is using;
 * `O_NOFOLLOW` so it cannot be a symlink someone planted; `fsync` before the rename so a crash
 * leaves either the old file or the new one, never a truncated new one.
 *
 * The temporary is unlinked on any failure, because a directory slowly filling with
 * `.agentdesk-files-*.tmp` is how a reader discovers this went wrong months later.
 */
async function writeAtomically(directory: string, name: string, bytes: Uint8Array): Promise<void> {
  const temporaryName = `.agentdesk-files-${crypto.randomUUID()}.tmp`;
  const temporaryPath = join(directory, temporaryName);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await fs.open(temporaryPath, flags, 0o600);
  } catch {
    throw new WorkspaceFailure("writeFailed");
  }
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, join(directory, name));
  } catch {
    await handle?.close().catch(() => {});
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw new WorkspaceFailure("writeFailed");
  }
}
