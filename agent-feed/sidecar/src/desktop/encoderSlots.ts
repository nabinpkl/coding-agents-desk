import { chmodSync, copyFileSync, mkdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { HelperBinary } from "./helperBinary.ts";

/**
 * Every live grid-encoder runs from its own copy of the installed helper.
 *
 * replayd, the daemon behind ScreenCaptureKit, files every stream client that runs from one
 * executable path under a single RPClient, and when any one of those processes disconnects it
 * runs `stopAllStreamsWithError` over the whole client: every other encoder's capture ends with
 * "Stream was stopped by the system" or "Failed during stream due to application connection
 * being interrupted". Measured 2026-09-05 with two encoders on one display: SIGTERM to the first
 * stopped the second within 100 ms when both ran from the same path, and left it untouched when
 * the second ran from a byte-identical copy at another path. This is also what the earlier
 * "a capture starting during another's teardown starves" and "two captures started close
 * together starve one" measurements were seeing.
 *
 * A slot is a numbered copy. It is free once the process last spawned from it has exited, and is
 * refreshed whenever the installed helper's mtime changes; the copy carries that mtime so the
 * check is one stat. Slot numbers are stable, so a diagnostics line can name one.
 */
const MAX_SLOTS = 64;

export function acquireEncoderSlot(
  source: HelperBinary,
  directory: string,
  occupied: (path: string) => boolean,
): string {
  if (!source.exists) throw new Error(`no installed helper to copy at ${source.path}`);
  mkdirSync(directory, { recursive: true });
  for (let index = 0; index < MAX_SLOTS; index += 1) {
    const path = join(directory, `grid-encoder.${index}`);
    if (occupied(path)) continue;
    if (!isCurrent(path, source.mtimeMs)) {
      try {
        copyFileSync(source.path, path);
      } catch (error) {
        // A process this sidecar does not know about, an orphan of a previous run, is still
        // executing the stale copy. Its watchdog reaps it within seconds; use the next slot.
        if ((error as NodeJS.ErrnoException).code === "ETXTBSY") continue;
        throw error;
      }
      chmodSync(path, 0o755);
      utimesSync(path, new Date(), new Date(source.mtimeMs));
    }
    return path;
  }
  throw new Error(`no free encoder slot under ${directory}`);
}

function isCurrent(path: string, mtimeMs: number): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0 && Math.abs(stat.mtimeMs - mtimeMs) < 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}
