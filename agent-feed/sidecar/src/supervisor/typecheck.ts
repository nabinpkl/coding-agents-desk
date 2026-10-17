// Whether a tree typechecks, asked before its code goes live -- by the sidecar's supervisor before a
// restart, and by the panel's dev server before an update reaches an open page.
//
// Both gates used to stop at parsing, for two reasons that stopped being true. A resident
// `tsc --watch` cost 844MB, and a type error was held never to break a running program. TypeScript 7
// checks either tree in about a second and gives the memory back when it exits (measured
// 2026-10-16: the panel's page code 0.96s and 374MB, the sidecar under a second). And on that same
// night two type errors did break running code: a sidecar saved with a call to `opencodeGoSource`
// before the line declaring it crash-looped on `ReferenceError`, and a hook saved with a new
// argument before its caller blanked the Feed tab with `all.map is not a function`. Every file
// parsed; the files did not agree. Only a typecheck sees that.
//
// The check runs in a CHILD process with one checker, the same reason `supervisorLinks.ts` gives:
// whoever asks must never wait on it, and one checker costs about 25% less memory than the default
// pool for a few tenths of a second. Errors are compared with a baseline rather than counted, so a
// tree that was already failing to check holds nothing new; only an error an edit introduced does.
//
// Node's APIs only, no Bun and no path aliases: the panel's `vite.config.ts` loads this under Node
// before any alias exists, the same way it loads `supervisorBoard.ts`.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface TypeCheckError {
  /** Absolute path of the file the error is in. */
  file: string;
  line: number;
  /** `TS2339` and the like. */
  code: string;
  message: string;
}

/** Long enough for a cold check of either tree many times over; it takes about a second warm. */
const TYPECHECK_TIMEOUT_MS = 60_000;

/**
 * Every error the project's own TypeScript reports, or why it could not be asked.
 *
 * `project` is the tsconfig. The compiler is the one installed beside it, so the panel and the
 * sidecar each check with their own and neither depends on the other's `node_modules`.
 */
export async function typeErrors(
  project: string,
  options: { timeoutMs?: number } = {},
): Promise<{ errors: TypeCheckError[] } | { failed: string }> {
  const directory = dirname(project);
  const compiler = join(directory, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(compiler)) return { failed: `no TypeScript installed beside ${basename(project)}` };
  return new Promise((done) => {
    execFile(
      process.execPath,
      [compiler, "-p", project, "--pretty", "false", "--checkers", "1"],
      { cwd: directory, timeout: options.timeoutMs ?? TYPECHECK_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const errors = parseErrors(stdout, directory);
        // A check that found errors exits non-zero too, so only an exit with nothing parsed is a
        // check that did not run.
        if (error && errors.length === 0) {
          const why = error.killed ? "no answer in time" : (stderr || stdout || error.message).trim().split("\n")[0];
          done({ failed: `could not typecheck: ${why}` });
          return;
        }
        done({ errors });
      },
    );
  });
}

/** `src/x.ts(12,7): error TS2339: Property 'y' does not exist ...`, one per line. */
const ERROR_LINE = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/;

export function parseErrors(output: string, directory: string): TypeCheckError[] {
  const errors: TypeCheckError[] = [];
  for (const line of output.split("\n")) {
    const match = ERROR_LINE.exec(line.trim());
    if (!match) continue;
    errors.push({ file: resolve(directory, match[1]!), line: Number(match[2]), code: match[3]!, message: match[4]! });
  }
  return errors;
}

/**
 * The errors in `now` that `baseline` did not have.
 *
 * Matched by file, code and message, never by line: an edit above an old error moves it, and a
 * moved error is not a new one. Counted, so a second copy of an error that already existed is new.
 */
export function introduced(baseline: readonly TypeCheckError[], now: readonly TypeCheckError[]): TypeCheckError[] {
  const seen = new Map<string, number>();
  for (const error of baseline) seen.set(keyOf(error), (seen.get(keyOf(error)) ?? 0) + 1);
  return now.filter((error) => {
    const left = seen.get(keyOf(error)) ?? 0;
    if (left === 0) return true;
    seen.set(keyOf(error), left - 1);
    return false;
  });
}

function keyOf(error: TypeCheckError): string {
  return `${error.file}\u0000${error.code}\u0000${error.message}`;
}

/** A check's answer: the errors the tree did not already have, or why it could not ask. */
export type BaselineCheck =
  | { failed: string }
  | {
      fresh: TypeCheckError[];
      /** Take the tree just checked as the running one: its errors stop being new. */
      accept(): void;
    };

/**
 * A check that remembers which errors the running tree already had, and reports only the new ones.
 *
 * The first answer is accepted as it stands, because it describes a tree that is already running:
 * a sidecar already started, a page already loaded. After that only `accept` moves the baseline,
 * which whoever runs the check calls once the tree it read has actually gone live.
 */
export function createTypeBaseline(project: string): () => Promise<BaselineCheck> {
  let baseline: TypeCheckError[] | null = null;
  return async () => {
    const result = await typeErrors(project);
    if ("failed" in result) return result;
    baseline ??= result.errors;
    return {
      fresh: introduced(baseline, result.errors),
      accept: () => {
        baseline = result.errors;
      },
    };
  };
}

/** One error the way a one-line panel row can show it. */
export function describeTypeError(error: TypeCheckError, more = 0): string {
  const rest = more > 0 ? ` (and ${more} more)` : "";
  return `${basename(error.file)}:${error.line}: ${error.message}${rest}`;
}
