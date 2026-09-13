// Putting an image into the composer of a Claude CLI, by writing a file it will agree to read.
//
// A terminal has no drop protocol and Claude Code does not want one. Measured in the CLI
// (2.1.263): dragging a file onto a terminal makes the EMULATOR type the file's path, and Claude's
// paste handler is what turns a path into an image. It splits the pasted text on a space that
// precedes a `/`, unquotes it, unescapes its backslashes, and then requires two things --
//
//   the name must match `/\.(png|jpe?g|gif|webp)$/i`, and the path must be ABSOLUTE
//
// -- before it reads the bytes, sniffs them independently of the name, resizes to the API's
// limits, and inserts `[Image #N]` into the box. A candidate that fails any of that is not an
// error: it is inserted into the composer as literal text, in front of whoever is sitting there.
// Measured, on a live pane: a relative path, a `~` path, and a path to a file that is not there
// all landed as visible text.
//
// So this module's whole job is to make a path that cannot fail those tests. It picks the
// extension by SNIFFING the bytes rather than by trusting what the browser called them, because
// the name and the content are checked separately by Claude and a disagreement between them is
// exactly the case that ends up in somebody's composer as a file path.
//
// Why a file at all, rather than the clipboard: `Ctrl+V` in that CLI reads the machine's OWN
// clipboard through `osascript`, so it can only ever carry an image that is already on the Mac the
// pane is on. A file written by the sidecar works for a session on another machine, because the
// sidecar that answers this request is running on that machine.

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComposerImageMediaType } from "@agentdesk/agent-feed-wire";
import { config } from "../config.ts";

/** How long a written image stays on disk before a later drop sweeps it away. */
const KEEP_MS = 24 * 60 * 60 * 1000;

/** The extension for each kind, which must satisfy Claude's own name test. */
const EXTENSIONS: Record<ComposerImageMediaType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * What these bytes actually are, or null when they are nothing a composer takes.
 *
 * By magic number, never by what the browser said. A `content-type` is a claim by the page that
 * sent it; the file this writes is read back by a program that sniffs for itself, so trusting the
 * claim would just move the disagreement one step further away from where it is noticed.
 */
export function imageMediaType(bytes: Uint8Array): ComposerImageMediaType | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // RIFF....WEBP: the four size bytes in between are the part that varies.
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    return "image/webp";
  }
  return null;
}

function starts(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/** Where the images live, and what an old one's lifetime is. Injected so a test needs no home. */
export interface ComposerImageStore {
  directory: string;
  now: () => number;
}

const LIVE_STORE: ComposerImageStore = {
  directory: config.composerImageDirectory,
  now: Date.now,
};

/**
 * Writes `bytes` where the pane's Claude can read them, and answers with the absolute path.
 *
 * The name is a random one with a sniffed extension. Deliberately NOT the name the browser gave
 * the file: that string arrives from a page and would be used to build a path, and there is
 * nothing a dropped file's own name buys that is worth being careful about for.
 *
 * Old images are swept on the way past rather than by a timer. The bytes are read by Claude within
 * a moment of the paste and it keeps its own base64 copy, so the file is only needed for an
 * instant; what it stays around for afterwards is the note the CLI writes about where the image
 * came from, which nobody needs a day later.
 */
export async function writeComposerImage(
  bytes: Uint8Array,
  mediaType: ComposerImageMediaType,
  store: ComposerImageStore = LIVE_STORE,
): Promise<string> {
  // A directory whose name could split the paste, or end it, would produce a path that reads as
  // several candidates and inserts most of itself as text. Said out loud here rather than
  // discovered in somebody's composer.
  if (/[\n\r]/.test(store.directory)) {
    throw new Error("the composer image directory must not contain a newline or an escape");
  }
  await mkdir(store.directory, { recursive: true, mode: 0o700 });
  void sweep(store);
  const path = join(store.directory, `${crypto.randomUUID()}.${EXTENSIONS[mediaType]}`);
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

/** Deletes images older than `KEEP_MS`. Failures are silent: this is tidying, not the request. */
async function sweep(store: ComposerImageStore): Promise<void> {
  let names: string[];
  try {
    names = await readdir(store.directory);
  } catch {
    return;
  }
  const cutoff = store.now() - KEEP_MS;
  await Promise.all(names.map(async (name) => {
    const path = join(store.directory, name);
    try {
      if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
    } catch {
      // Another sweep got there first, or it is not ours to delete.
    }
  }));
}
