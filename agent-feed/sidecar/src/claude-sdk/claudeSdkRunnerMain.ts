// The process a session runs in, in SDK mode: `bun claudeSdkRunnerMain.ts --session <id> ...`.
//
// Started inside the session's own tmux pane (`claudeSdkLaunch.ts`), never by the sidecar as its
// child, because the sidecar restarts on every save and a child would go with it. tmux keeps this
// alive instead; the sidecar only ever connects to the socket it serves. Everything it needs comes
// on its command line, decided by the sidecar, so it reads no config of its own -- and its pane's
// start command says what session it is, which is how the pane is recognised later.
//
// Its output is the pane's log: a line when it starts, when it ends, and when something fails.

import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { query, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_PERMISSION_MODES, type ClaudePermissionMode } from "@agentdesk/agent-feed-wire";
import { ClaudeSdkRunner, type RunnerPlan, type RunnerQuery } from "@/claude-sdk/claudeSdkRunner";
import { privateSocketDirectory, serveRunner } from "@/claude-sdk/claudeSdkRunnerServer";
import { runnerSocketPath } from "@/claude-sdk/claudeSdkProtocol";

/** How long a stop waits for `claude` to write its exit records before the runner leaves anyway. */
const STOP_GRACE_MS = 15_000;

function log(line: string): void {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

/**
 * `claude` in a process group of its own, and the whole group ended when it exits.
 *
 * When the CLI exits it stops the MCP servers it started but not their children, which then run on
 * writing to a pipe nobody reads; they stay in the CLI's group, so the group gets SIGKILL once the
 * CLI is gone. Adapted from t3code's `spawnClaudeProcessGroup`
 * (apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts, MIT, Copyright (c) 2026 T3 Tools
 * Inc.). Its stderr goes to this pane rather than nowhere, so a CLI that fails says so here.
 */
function spawnProcessGroup(options: SpawnOptions): SpawnedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "inherit"],
    detached: true,
  });
  child.once("exit", () => {
    // `kill(-pid)` addresses the group; a pid of 0 or 1 would address this group or every process.
    if (child.pid && child.pid > 1) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already empty.
      }
    }
  });
  return child as unknown as SpawnedProcess;
}

function permissionMode(value: string | undefined): ClaudePermissionMode {
  if (!(CLAUDE_PERMISSION_MODES as readonly (string | undefined)[]).includes(value)) {
    throw new Error(`--permission-mode must be one of ${CLAUDE_PERMISSION_MODES.join(", ")}`);
  }
  return value as ClaudePermissionMode;
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/** Reads the first turn out of the file the launch wrote, then removes the file and its directory. */
async function takeFirstTurn(file: string | undefined): Promise<string | undefined> {
  if (!file) return undefined;
  const text = await readFile(file, "utf8");
  await rm(dirname(file), { recursive: true, force: true });
  return text.trim() ? text : undefined;
}

export async function planFromArguments(argv: string[]): Promise<{ plan: RunnerPlan; socketDirectory: string }> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      session: { type: "string" },
      cwd: { type: "string" },
      name: { type: "string" },
      start: { type: "string" },
      "permission-mode": { type: "string" },
      "allow-bypass": { type: "boolean", default: false },
      "plugin-dir": { type: "string", multiple: true, default: [] },
      claude: { type: "string" },
      "socket-dir": { type: "string" },
      "first-turn-file": { type: "string" },
      "fork-from": { type: "string" },
      "resume-at": { type: "string" },
    },
  });
  const start = values.start;
  if (start !== "new" && start !== "resume" && start !== "fork") throw new Error("--start must be new, resume or fork");
  if (start === "fork" && !values["fork-from"]) throw new Error("--start fork needs --fork-from");
  const firstTurn = await takeFirstTurn(values["first-turn-file"]);
  return {
    plan: {
      sessionId: required("session", values.session),
      cwd: required("cwd", values.cwd),
      name: required("name", values.name),
      start,
      permissionMode: permissionMode(values["permission-mode"]),
      allowBypass: values["allow-bypass"] === true,
      pluginDirectories: values["plugin-dir"] ?? [],
      claudePath: required("claude", values.claude),
      ...(values["fork-from"] ? { forkFrom: values["fork-from"] } : {}),
      ...(values["resume-at"] ? { resumeAt: values["resume-at"] } : {}),
      ...(firstTurn === undefined ? {} : { firstTurn }),
    },
    socketDirectory: required("socket-dir", values["socket-dir"]),
  };
}

async function main(): Promise<number> {
  const { plan, socketDirectory } = await planFromArguments(process.argv.slice(2));
  await using stack = new AsyncDisposableStack();
  const runner = new ClaudeSdkRunner(plan, ({ prompt, options }) =>
    query({ prompt, options: { ...options, spawnClaudeCodeProcess: spawnProcessGroup } }) as RunnerQuery);

  await privateSocketDirectory(socketDirectory);
  const socketPath = runnerSocketPath(socketDirectory, plan.sessionId);
  const server = await serveRunner(runner, { sessionId: plan.sessionId, socketPath }, log);
  stack.defer(() => server.close());

  // A closed pane is a hangup and a killed one a terminate. Either way the session ends the way a
  // terminal's does, writing its exit records, with a grace period in case `claude` does not.
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: ending the session`);
    void runner.stop();
    setTimeout(() => {
      log("the session did not end in time; leaving anyway");
      process.exit(1);
    }, STOP_GRACE_MS).unref();
  };
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(signal, () => stop(signal));

  log(`${plan.start === "new" ? "starting" : "resuming"} ${plan.sessionId} "${plan.name}" in ${plan.cwd}`);
  log(`claude ${plan.claudePath}, ${plan.permissionMode} mode, listening at ${socketPath}`);
  await runner.run(log);
  log(`session ${plan.sessionId} has ended`);
  return 0;
}

if (import.meta.main) {
  process.on("unhandledRejection", (reason) => {
    log(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
    process.exit(1);
  });
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      log(`could not run the session: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
