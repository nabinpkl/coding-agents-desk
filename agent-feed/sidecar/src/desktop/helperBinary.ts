import { statSync } from "node:fs";
import { config } from "../config.ts";

/**
 * Installed helper location and generation, shared by capture pools and control.
 * `just grid-encoder-install` atomically replaces changed content with a newer
 * mtime. Reuse checks therefore pick up updates without hashing the executable
 * on every request. Compiling alone leaves the installed generation untouched.
 */
export interface HelperBinary {
  path: string;
  /** Modification time in milliseconds. Zero when the binary is missing. */
  mtimeMs: number;
  exists: boolean;
}

export function helperBinary(path = config.gridEncoderPath): HelperBinary {
  if (!path) return { path: "", mtimeMs: 0, exists: false };
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0 || (stat.mode & 0o111) === 0) {
      return { path, mtimeMs: 0, exists: false };
    }
    return { path, mtimeMs: stat.mtimeMs, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A fresh runtime has no installed helper. Callers return an explicit 503
    // naming the install recipe, never fall back to disposable build output.
    return { path, mtimeMs: 0, exists: false };
  }
}

/** The message every caller shows when the binary is not there. One wording, one place. */
export function missingHelperMessage(path: string): string {
  return `no installed desktop helper at ${path}; run just grid-encoder-install (no app reinstall)`;
}
