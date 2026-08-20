// What the summarizer is shown: one turn's events, plus what the working tree looks like now.
//
// Two facts, gathered together because a digest needs both and neither is sufficient. The
// transcript says what the agent SAID it did; `git diff` says what is actually on disk. They
// disagree more often than is comfortable -- an edit reverted three tool calls later, a file
// written by a build the agent ran, a change the agent made and forgot to mention.
//
// Nothing here calls a model. This module is pure enough to test against a fake page reader and
// a fake command runner, which is the whole reason the model-facing half is a separate file.

import type { SummaryCoverage, SummaryFileChange } from "@agentdesk/agent-feed-wire";
import type { CommandRunner } from "../tasks/processProbe.ts";
import type { ActivityEvent, EventMode } from "../transcripts/sources/transcriptTypes.ts";

/** Absolute for the same reason `processProbe` resolves its binaries absolutely: the sidecar is
 *  spawned by the Mac host, whose PATH is not a developer shell's. */
const GIT_BINARY = "/usr/bin/git";

/**
 * Git, run quietly.
 *
 * Its own runner rather than `processProbe`'s: that one is shaped for `pgrep`/`lsof` and logs
 * failures as `agent-feed-task-probe-failed`, which is a misleading thing to print when what
 * actually happened is that a project is not a git repository. That is not an error here -- a
 * summary of a directory with no VCS is a perfectly good summary with no working-tree block --
 * so exit 128 with nothing on stdout is silent, and only an unexpected failure says anything.
 */
export const runGit: CommandRunner = async (argv) => {
  try {
    const proc = Bun.spawn(argv as string[], {
      stdout: "pipe",
      stderr: "pipe",
      // The C locale, because we PARSE this output. Same scar as processProbe.
      env: { ...process.env, LC_ALL: "C" },
    });
    const [text, diagnostic] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    // 128 is git's "this is not a repository", which is an ordinary answer.
    if (code !== 0 && code !== 128 && diagnostic.trim()) {
      console.error(JSON.stringify({
        event: "agent-feed-summary-git-failed",
        command: argv.slice(0, 4).join(" "),
        exitCode: code,
        detail: diagnostic.trim().slice(0, 200),
      }));
    }
    return text;
  } catch (error) {
    console.error(JSON.stringify({
      event: "agent-feed-summary-git-unavailable",
      detail: String(error).slice(0, 200),
    }));
    return "";
  }
};

/**
 * How many events one page of the backwards walk reads.
 *
 * Deliberately not `TIMELINE_WINDOW`. That constant sizes what a viewer sees when a thread opens;
 * this one sizes an internal scan, and tying them would make a change to the panel's opening
 * window silently change how far back the summarizer looks for a turn boundary.
 */
const SCAN_PAGE = 100;

/**
 * How many pages back to look for the turn boundary before giving up and summarizing what was
 * found. A turn longer than 1,000 events is past the token ceiling anyway, so walking further
 * would only buy a more precise `fromEventIndex` on a window that is about to be truncated.
 */
const MAX_SCAN_PAGES = 10;

/** Rough tokens-per-character. Deliberately pessimistic: overestimating truncates a little early,
 *  underestimating gets the request refused by the model, and only one of those is recoverable. */
const CHARS_PER_TOKEN = 3.5;

/** Reads one page of a session's events. Injected so this module never learns whether the
 *  session is backed by a transcript on disk or by an agent backend -- the route already knows. */
export type PageReader = (
  offset: number,
  limit: number,
) => Promise<{ events: ActivityEvent[]; total: number } | null>;

export interface TurnWindow {
  /** The events the summarizer will be shown, oldest first, starting at the user message. */
  events: ActivityEvent[];
  coverage: SummaryCoverage;
  /** Human-readable git state, injected into the prompt verbatim. Empty when the project is not
   *  a git repository or has no changes. */
  gitBlock: string;
  filesTouched: SummaryFileChange[];
}

export interface TurnWindowOptions {
  project: string;
  mode: EventMode;
  readPage: PageReader;
  tokenCeiling: number;
  /** Injected only by tests; production takes the module's own quiet git runner. */
  runCommand?: CommandRunner;
}

/**
 * The window from the most recent user message to the end of the transcript.
 *
 * Returns null only when the session has no events at all. A session whose last user message
 * cannot be found within the scan limit still yields a window -- the deepest page reached --
 * because "here is the last thousand events" is a better answer than nothing, and `coverage`
 * says exactly what was seen.
 */
export async function resolveTurnWindow(options: TurnWindowOptions): Promise<TurnWindow | null> {
  const { readPage, mode, tokenCeiling } = options;

  const first = await readPage(Math.max(0, 0), SCAN_PAGE);
  if (!first) return null;
  const total = first.total;
  if (total === 0) return null;

  const collected: ActivityEvent[] = [];
  let boundaryFound = false;
  let offset = Math.max(0, total - SCAN_PAGE);
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const limit = Math.min(SCAN_PAGE, total - offset);
    const read = limit > 0 ? await readPage(offset, limit) : null;
    const events = read?.events ?? [];
    collected.unshift(...events);
    const boundary = lastUserIndex(collected);
    if (boundary !== -1) {
      collected.splice(0, boundary);
      boundaryFound = true;
      break;
    }
    if (offset === 0) break;
    offset = Math.max(0, offset - SCAN_PAGE);
  }

  const { events, truncated } = fitToCeiling(collected, tokenCeiling);
  const git = await readGitState(options.project, options.runCommand ?? runGit);

  return {
    events,
    coverage: {
      fromEventIndex: events[0]?.index ?? 0,
      toEventIndex: events[events.length - 1]?.index ?? 0,
      mode,
      // Not finding the boundary is itself a form of not seeing the whole turn, so it reports as
      // truncation rather than as a silently partial window.
      truncated: truncated || !boundaryFound,
    },
    gitBlock: git.block,
    filesTouched: git.files,
  };
}

/** Index of the last `user` event, or -1. */
function lastUserIndex(events: readonly ActivityEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === "user") return i;
  }
  return -1;
}

/**
 * Drop from the MIDDLE, never from either end.
 *
 * The two ends are the two things a digest cannot be written without: the user's request at the
 * front and the agent's most recent work at the back. A tail-only window loses the question; a
 * head-only window loses the answer.
 */
function fitToCeiling(
  events: readonly ActivityEvent[],
  tokenCeiling: number,
): { events: ActivityEvent[]; truncated: boolean } {
  const budget = tokenCeiling * CHARS_PER_TOKEN;
  const sizes = events.map(eventChars);
  const totalChars = sizes.reduce((sum, size) => sum + size, 0);
  if (totalChars <= budget) return { events: [...events], truncated: false };

  const head: ActivityEvent[] = [];
  const tail: ActivityEvent[] = [];
  let used = 0;
  let low = 0;
  let high = events.length - 1;
  // Alternate outward-in from both ends so the head and the tail get roughly half each,
  // whichever side happens to carry the larger events.
  while (low <= high) {
    const takeTail = tail.length < head.length;
    const pick = takeTail ? high : low;
    const size = sizes[pick]!;
    if (used + size > budget) break;
    used += size;
    if (takeTail) {
      tail.unshift(events[pick]!);
      high -= 1;
    } else {
      head.push(events[pick]!);
      low += 1;
    }
  }
  return { events: [...head, ...tail], truncated: true };
}

function eventChars(event: ActivityEvent): number {
  let count = 0;
  for (const block of event.blocks) {
    count += (block.text?.length ?? 0) + (block.preview?.length ?? 0) + (block.summary?.length ?? 0);
    if (block.input) count += JSON.stringify(block.input).length;
  }
  // Floor, so a page of empty-bodied machinery lines still costs something and cannot make the
  // estimate claim a 10,000-event window fits.
  return Math.max(count, 32);
}

interface GitState {
  block: string;
  files: SummaryFileChange[];
}

/**
 * The working tree against HEAD, plus untracked files.
 *
 * `diff HEAD` rather than a bare `diff` because a turn that staged its work would otherwise
 * report nothing changed. Untracked files come from `status --porcelain` and carry status `?`:
 * a newly created file is the single most common thing a turn does, and it is invisible to
 * every form of `git diff`.
 */
async function readGitState(project: string, runCommand: CommandRunner): Promise<GitState> {
  const [numstat, nameStatus, untracked] = await Promise.all([
    runCommand([GIT_BINARY, "-C", project, "diff", "HEAD", "--numstat"]),
    runCommand([GIT_BINARY, "-C", project, "diff", "HEAD", "--name-status"]),
    runCommand([GIT_BINARY, "-C", project, "ls-files", "--others", "--exclude-standard"]),
  ]);

  const statusByPath = new Map<string, string>();
  for (const line of nameStatus.split("\n")) {
    const [status, ...rest] = line.split("\t");
    const path = rest[rest.length - 1];
    if (status && path) statusByPath.set(path, status);
  }

  const files: SummaryFileChange[] = [];
  for (const line of numstat.split("\n")) {
    const [added, removed, ...rest] = line.split("\t");
    const path = rest[rest.length - 1];
    if (!path || added === undefined || removed === undefined) continue;
    files.push({
      path,
      status: statusByPath.get(path) ?? "M",
      // `-` is git's marker for a binary file, where a line count is not defined.
      added: added === "-" ? 0 : Number(added) || 0,
      removed: removed === "-" ? 0 : Number(removed) || 0,
    });
  }
  for (const path of untracked.split("\n")) {
    if (!path.trim()) continue;
    files.push({ path: path.trim(), status: "?", added: 0, removed: 0 });
  }

  if (files.length === 0) return { block: "", files };
  const rendered = files
    .map((file) => `${file.status}\t+${file.added}\t-${file.removed}\t${file.path}`)
    .join("\n");
  return { block: `Working tree vs HEAD (status, added, removed, path):\n${rendered}`, files };
}
