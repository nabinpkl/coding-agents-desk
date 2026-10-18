// Driving one Claude contestant: spawn `claude --print` in the contestant's worktree, feed it
// the run's prompt on stdin, and take the process's exit as the turn's close.
//
// Everything measured, on this machine's CLI (2.1.x), and pinned here because none of it is
// what the flags' names would suggest:
//
//   - The prompt rides STDIN. The help says "stdin or as a prompt argument", but the
//     positional argument is not accepted in print mode; stdin is the spelling that works.
//   - A contestant runs with this machine's own setup -- its hooks, CLAUDE.md, skills, plugins
//     and MCP servers -- as a reader's own Claude session does. `--safe-mode`, which drops all of
//     that, is not passed (ADR-0138). Neither is `--bare`, which also drops keychain auth and
//     answers "Not logged in".
//   - Nothing confines a contestant: it runs with this machine's own permission mode and every
//     tool a reader's own session has (ADR-0139). The worktree-scoped rules ADR-0130 added were
//     never a wall -- Bash was always unscoped, and Claude's own refusal invites trying another
//     tool, which a contestant did with `cat` -- so they went, and what a contestant reached
//     outside its worktree is a fact read off its events instead (`outsideReaches`).
//   - `--session-id` is accepted and names the transcript that lands at
//     `~/.claude/projects/<slug>/<id>.jsonl`, so the id is chosen here rather than
//     discovered, and the session is in the catalog from the moment the file exists. The
//     file is found back by that name (`claudeTranscriptPath`), never by rebuilding the slug,
//     whose mangling rules are the harness's business.
//   - The process EXITS when the turn ends. That is the completion signal: no projection to
//     subscribe to, no run state to watch.
//
// The facts are read back from that transcript through the same adapter that renders it
// everywhere else (`claudeAdapter.processLine`), which is why the file list and usage a
// Claude contestant records are the same shapes an opencode contestant's events carry.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { ContestantPlan, ContestantResult } from "@/arena/contestants/contestantDriver";
import { claudeBinary } from "@/config/configBinaries";
import { claudeTranscriptPath } from "@/tasks/taskIdentity";
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";
import type { ActivityEvent, LineResult } from "@/transcripts/transcriptTypes";

export class ClaudeContestantError extends Error {}

/** What stderr may contribute to a failure line: enough to name the cause, not the whole log. */
const STDERR_TAIL_CHARACTERS = 400;

/**
 * The argv that drives one contestant, split out because it is pure and the spelling is the
 * part a future CLI release is most likely to move.
 */
export function claudeContestantArgv(options: {
  /** Absolute: the sidecar's PATH is stripped, so a bare `claude` finds nothing. */
  binary: string;
  sessionId: string;
  model?: string | null;
  effort?: string | null;
  /**
   * The terminals mode's spelling: the interactive CLI in a pane rather than `--print`, under its
   * name (`-n`) so the session reads as a contestant wherever it is listed.
   */
  interactive?: { name: string };
  /** A later prompt of the run: the session is resumed rather than created under this id. */
  resume?: boolean;
}): string[] {
  const argv = options.interactive
    ? [options.binary, "--session-id", options.sessionId, "-n", options.interactive.name]
    : [options.binary, "--print", options.resume ? "--resume" : "--session-id", options.sessionId];
  if (options.model) argv.push("--model", options.model);
  if (options.effort) argv.push("--effort", options.effort);
  return argv;
}

/**
 * The turn's events and last usage, read back from the transcript through the same adapter
 * that renders it everywhere else.
 *
 * Lines the adapter refuses, or classes as machinery (a queue record, a header row), are
 * skipped rather than failed: the transcript is full of machinery a facts pass has no use
 * for, and the adapter is the one place that already knows which is which.
 */
export function factsFromClaudeTranscript(text: string): {
  events: ActivityEvent[];
  usage: ContestantResult["usage"];
} {
  const events: ActivityEvent[] = [];
  let usage: ContestantResult["usage"] = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const result: LineResult | null = claudeAdapter.processLine(line);
    if (!result) continue;
    if (result.usage) usage = result.usage;
    const event = result.event;
    if (!event || result.lineClass === "machinery") continue;
    events.push({
      ...event,
      id: `claude:${events.length}`,
      index: events.length,
      revision: 1,
      phase: "complete",
    });
  }
  return { events, usage };
}

/** The child this driver spawns, narrowed to what it uses so a test can fake all of it. */
export interface SpawnedClaude {
  exited: Promise<number>;
  stderrText(): Promise<string>;
  kill(): void;
}

async function spawnClaude(argv: string[], cwd: string, prompt: string): Promise<SpawnedClaude> {
  // The reply is not read here -- the transcript holds it -- so stdout goes nowhere rather than
  // into a pipe nobody drains: a reply past the pipe's buffer would block the child until the
  // timeout killed it. Stderr IS kept, for the failure line, and read from the start for the
  // same reason.
  const child = Bun.spawn(argv, { cwd, stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  await child.stdin.write(prompt);
  await child.stdin.end();
  return {
    exited: child.exited,
    stderrText: () => stderr,
    kill: () => child.kill(),
  };
}

/**
 * Drives one Claude contestant and resolves when its turn has closed.
 *
 * The session id is chosen, not answered, so `onSessionId` fires before the harness has done
 * anything: the id names a transcript that will exist, and a reader can be pointed at the
 * session before the model has read a word.
 */
export async function runClaudeContestant(
  plan: ContestantPlan,
  options: {
    model?: string | null;
    effort?: string | null;
    /** Overrides the binary lookup; null is "not installed", as the lookup answers it. */
    binary?: string | null;
    newSessionId?: () => string;
    spawn?: (argv: string[], cwd: string, prompt: string) => Promise<SpawnedClaude>;
    /** Finds and reads the session's transcript; the real one looks it up by session id. */
    readTranscript?: (sessionId: string) => Promise<string>;
  } = {},
): Promise<ContestantResult> {
  // Before the session id is announced: a contestant with no CLI to run has no session, and
  // its record should not name one that will never exist.
  const binary = options.binary !== undefined ? options.binary : claudeBinary();
  if (!binary) {
    throw new ClaudeContestantError("no claude CLI on this machine: install it, or set AGENT_FEED_CLAUDE_PATH");
  }
  const sessionId = plan.continues ?? options.newSessionId?.() ?? randomUUID();
  plan.onSessionId(sessionId);

  const argv = claudeContestantArgv({
    binary,
    sessionId,
    model: options.model,
    effort: options.effort,
    resume: plan.continues !== undefined,
  });
  const spawn = options.spawn ?? spawnClaude;
  const child = await spawn(argv, plan.worktreePath, plan.prompt);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, plan.turnTimeoutMs);
  timer.unref?.();
  try {
    const code = await child.exited;
    if (timedOut) {
      throw new ClaudeContestantError(`contestant did not close its turn within ${plan.turnTimeoutMs}ms`);
    }
    if (code !== 0) {
      const stderr = (await child.stderrText()).trim();
      throw new ClaudeContestantError(`claude exited ${code}: ${stderr.slice(-STDERR_TAIL_CHARACTERS)}`);
    }
  } finally {
    clearTimeout(timer);
  }

  const text = await (options.readTranscript ?? readClaudeTranscript)(sessionId);
  const { events, usage } = factsFromClaudeTranscript(text);
  return { sessionId, events, usage };
}

/** A closed turn with no transcript is a broken harness, not an empty turn: it fails loud. */
export async function readClaudeTranscript(sessionId: string): Promise<string> {
  const path = await claudeTranscriptPath(sessionId);
  if (!path) {
    throw new ClaudeContestantError(`no transcript for session ${sessionId} after its turn closed`);
  }
  return readFileSync(path, "utf8");
}
