// Running `rg` for the IDE: one process per search, killed the moment nobody wants its answer.
//
// The argv is passed as an argv, never as a shell string, so a query holding `;`, `$(...)` or a
// quote is only ever text to search for (AGENTS.md, "An argv flattened into a shell string").

/** Why a search could not run, in the wire's error codes. */
export type SearchFailureCode = "searchUnavailable" | "searchBusy" | "invalidQuery";

export class SearchFailure extends Error {
  constructor(readonly code: SearchFailureCode, message: string) {
    super(message);
    this.name = "SearchFailure";
  }
}

/**
 * How many searches may run at once on this sidecar, across every workspace and reader.
 *
 * The caller is unauthenticated, and each search is a process walking a directory tree on every
 * core. A reader typing produces one search per pause and cancels the last, so this is only ever
 * reached by something that is not a reader typing.
 */
export const MAXIMUM_RUNNING_SEARCHES = 4;

/** The most output one search may produce before it is stopped, whatever it was asked. */
export const MAXIMUM_OUTPUT_BYTES = 64 * 1024 * 1024;

let running = 0;

export interface RipgrepRun {
  /** True when the caller or a cap stopped `rg` before it finished. */
  stopped: boolean;
}

/**
 * Run `rg` and hand each output record to `onRecord`, which answers false to stop.
 *
 * Records are split on `separator`: a newline for `--json`, NUL for `--files --null`, since a
 * file name may hold a newline. Exit 1 is "no matches" and exit 2 with output is "some files
 * could not be read", so neither is a failure; exit 2 is reported only when `rg` refused the
 * query itself (a regex or a glob that does not parse), with its own words.
 */
export async function runRipgrep(
  binary: string | null,
  args: readonly string[],
  cwd: string,
  onRecord: (record: string) => boolean,
  options: { separator: "\n" | "\0"; signal?: AbortSignal },
): Promise<RipgrepRun> {
  if (!binary) {
    throw new SearchFailure("searchUnavailable", "ripgrep (rg) is not installed on this machine.");
  }
  if (running >= MAXIMUM_RUNNING_SEARCHES) {
    throw new SearchFailure("searchBusy", "Too many searches are running; try again in a moment.");
  }
  if (options.signal?.aborted) return { stopped: true };

  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([binary, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new SearchFailure("searchUnavailable", `ripgrep could not start: ${String(error)}`);
  }
  running += 1;

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    child.kill();
  };
  options.signal?.addEventListener("abort", stop, { once: true });

  try {
    const stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const decoder = new TextDecoder();
    let pending = "";
    let bytes = 0;
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      if (stopped) break;
      bytes += chunk.byteLength;
      if (bytes > MAXIMUM_OUTPUT_BYTES) {
        stop();
        break;
      }
      pending += decoder.decode(chunk, { stream: true });
      const records = pending.split(options.separator);
      pending = records.pop() ?? "";
      for (const record of records) {
        if (record !== "" && !onRecord(record)) {
          stop();
          break;
        }
      }
    }
    if (!stopped && pending !== "") onRecord(pending);
    const code = await child.exited;
    const message = (await stderr).trim();
    if (!stopped && code === 2 && /regex parse error|error parsing glob|unrecognized/i.test(message)) {
      // rg draws a caret under the offending column, which means nothing once the lines are
      // folded, so only its first line and its verdict travel: "regex parse error: unclosed group".
      const lines = message.replace(/^rg: /, "").split("\n").map((line) => line.trim());
      const verdict = lines.findLast((line) => line.startsWith("error:"))?.slice(6).trim();
      throw new SearchFailure("invalidQuery", verdict ? `${lines[0]} ${verdict}` : lines[0] ?? message);
    }
    return { stopped };
  } finally {
    running -= 1;
    options.signal?.removeEventListener("abort", stop);
    stop();
  }
}
