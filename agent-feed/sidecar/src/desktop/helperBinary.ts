import { statSync } from "node:fs";
import { config } from "../config.ts";

/**
 * Where the compiled helper is, and WHICH BUILD of it.
 *
 * The second half is the point. `tools/build-grid-encoder.sh` takes about seven seconds and needs
 * no app rebuild, which is the whole reason the AX surface lives out there -- but a rebuild only
 * counts if the next spawn actually picks it up. Both spawn paths reuse a running child (the tile
 * pool by command line, the WebRTC path by window id), so without this a helper started before the
 * rebuild keeps serving the old code, and the seven-second loop silently becomes a lie. That is the
 * same stale-binary trap `pair-sim` has, and it produces the same wrong conclusions.
 *
 * mtime rather than a content hash: the file is tens of megabytes, this is read on every acquire,
 * and the question is only "is this the same build I already spawned". A rebuild always moves the
 * mtime; nothing else here can.
 */
export interface HelperBinary {
  path: string;
  /** Modification time in milliseconds. Zero when the binary is missing. */
  mtimeMs: number;
  exists: boolean;
}

export function helperBinary(): HelperBinary {
  const path = config.gridEncoderPath;
  if (!path) return { path: "", mtimeMs: 0, exists: false };
  try {
    return { path, mtimeMs: statSync(path).mtimeMs, exists: true };
  } catch {
    // A missing binary is an ordinary state -- a fresh checkout has not run the build script yet --
    // and every caller turns it into a 503 that names the script. Nothing to log here.
    return { path, mtimeMs: 0, exists: false };
  }
}

/** The message every caller shows when the binary is not there. One wording, one place. */
export function missingHelperMessage(path: string): string {
  return `no grid encoder at ${path}; run tools/build-grid-encoder.sh`;
}
