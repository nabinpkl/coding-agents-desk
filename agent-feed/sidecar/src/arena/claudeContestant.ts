// Driving one Claude contestant: spawn `claude --print` in the contestant's worktree, feed it
// the run's prompt on stdin, and take the process's exit as the turn's close.
//
// Everything measured, on this machine's CLI (2.1.x), and pinned here because none of it is
// what the flags' names would suggest:
//
//   - The prompt rides STDIN. The help says "stdin or as a prompt argument", but the
//     positional argument is not accepted in print mode; stdin is the spelling that works.
//   - `--safe-mode` is the context control. It drops the machine's hooks, CLAUDE.md discovery,
//     skills and MCP servers while keeping auth and built-in tools, which is what keeps a
//     contestant's context about the prompt rather than about this machine. (`--bare` looks
//     like the same idea and is not: it drops keychain auth entirely and answers "Not logged
//     in".) Without either, the machine's own hooks load and the request can arrive over the
//     context limit before the model reads a word.
//   - Permission prompts do not hang print mode: built-in tools execute, whitelisted or not.
//     The whitelist below is still passed, as the boundary of what a contestant may do, not
//     as the thing that stops a hang.
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
import type { ContestantPlan, ContestantResult } from "@/arena/contestantDriver";
import { claudeBinary } from "@/config/configBinaries";
import { claudeTranscriptPath } from "@/tasks/taskIdentity";
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";
import type { ActivityEvent, LineResult } from "@/transcripts/transcriptTypes";

export class ClaudeContestantError extends Error {}

/** What stderr may contribute to a failure line: enough to name the cause, not the whole log. */
const STDERR_TAIL_CHARACTERS = 400;

/** The tools a contestant may use. A boundary, not a hang-guard: print mode auto-allows built-ins. */
const CONTESTANT_TOOLS = "Read,Grep,Glob,Bash,Edit,Write";

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
  tools?: string;
}): string[] {
  const argv = [options.binary, "--print", "--safe-mode", "--session-id", options.sessionId];
  if (options.model) argv.push("--model", options.model);
  if (options.effort) argv.push("--effort", options.effort);
  argv.push("--allowed-tools", options.tools ?? CONTESTANT_TOOLS);
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
    tools?: string;
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
    throw new ClaudeContestantError(
      "no claude CLI on this machine: install it, or set AGENT_FEED_CLAUDE_PATH",
    );
  }
  const sessionId = options.newSessionId?.() ?? randomUUID();
  plan.onSessionId(sessionId);

  const argv = claudeContestantArgv({
    binary,
    sessionId,
    model: options.model,
    effort: options.effort,
    tools: options.tools,
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
      throw new ClaudeContestantError(
        `contestant did not close its turn within ${plan.turnTimeoutMs}ms`,
      );
    }
    if (code !== 0) {
      const stderr = (await child.stderrText()).trim();
      throw new ClaudeContestantError(
        `claude exited ${code}: ${stderr.slice(-STDERR_TAIL_CHARACTERS)}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }

  const text = await (options.readTranscript ?? readClaudeTranscript)(sessionId);
  const { events, usage } = factsFromClaudeTranscript(text);
  return { sessionId, events, usage };
}

/** A clean exit with no transcript is a broken harness, not an empty turn: it fails loud. */
async function readClaudeTranscript(sessionId: string): Promise<string> {
  const path = await claudeTranscriptPath(sessionId);
  if (!path) {
    throw new ClaudeContestantError(`no transcript for session ${sessionId} after a clean exit`);
  }
  return readFileSync(path, "utf8");
}
