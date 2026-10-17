// A small JSON file this sidecar owns, written so two sidecars sharing it cannot interleave.
//
// `bots.json` and `session-archive.json` are both read by every sidecar this user runs (the stable
// and `.dev` hosts share one home directory), so a write takes an exclusive lock file first and
// lands as a temp file plus a `rename`, which a reader can never see half done.

import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

/** Takes `<path>.lock`, waiting out a live holder and clearing one left by a dead process. */
export async function acquireFileLock(path: string): Promise<() => Promise<void>> {
  const name = basename(path);
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } catch (error) {
        await handle.close();
        await rm(lockPath, { force: true });
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await handle.close();
        } finally {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(`failed to lock ${name} at ${path}`, { cause: error });
      }

      try {
        const lock = await stat(lockPath);
        if (Date.now() - lock.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(`failed to inspect ${name} lock at ${lockPath}`, { cause: lockError });
      }

      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${name} lock at ${lockPath}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}

/** Replaces `path` with `value` as pretty JSON, through a synced temp file and a `rename`. */
export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stem = basename(path).replace(/\.json$/, "");
  const temporary = join(directory, `.${stem}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `failed to write and clean up ${basename(path)} at ${path}`, {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
