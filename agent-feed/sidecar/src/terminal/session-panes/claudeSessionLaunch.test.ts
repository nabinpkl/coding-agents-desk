// What is worth pinning here is not the shape of the argv -- it is that the argv survives.
//
// This command is built as a list, flattened into one string, handed to `/bin/sh -c` by tmux, and
// split back into arguments by a shell that has never heard of it. That round trip has already
// cost this repo an evening once, when a title containing `(fork 1)` reached zsh and came back as
// `invalid mode specification`. A launch prompt is the same argument only much longer and much
// more hostile, so the test that matters runs it through the real shells and reads the argv that
// arrives.

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeForkPaneName,
  claudeSessionPaneName,
  firstTurnFromFile,
  forkClaudeSessionCommand,
  forkFirstTurn,
  newClaudeSessionCommand,
  restartClaudeSession,
  resumeClaudeSessionCommand,
  resumeSelection,
} from "@/terminal/session-panes/claudeSessionLaunch";
import { newSessionArgs, respawnPaneArgs } from "@/terminal/tmux/tmuxSessions";
import { claudeLaunchArgs as permission } from "@/config/configClaudeLaunch";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("the pane name is the session id, so a second viewer lands on the first's pane", () => {
  expect(claudeSessionPaneName("0a9952cf-8338-46cf-bfd8-3f82e941b969")).toBe(
    "agentdesk-0a9952cf-8338-46cf-bfd8-3f82e941b969",
  );
});

test("the command names the session and its title, and carries a prompt as the first turn", () => {
  expect(newClaudeSessionCommand({ sessionId: "abc", title: "OSS agent", prompt: "read AGENTS.md" })).toEqual([
    "claude",
    ...permission,
    "--session-id",
    "abc",
    "-n",
    "OSS agent",
    "read AGENTS.md",
  ]);
});

test("no prompt means no trailing argument, not an empty one", () => {
  // An empty positional would be a first turn of nothing, which the CLI answers.
  expect(newClaudeSessionCommand({ sessionId: "abc", title: "OSS agent" })).toEqual([
    "claude",
    ...permission,
    "--session-id",
    "abc",
    "-n",
    "OSS agent",
  ]);
});

test("a hostile prompt arrives as exactly one argument, through the shells tmux uses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentdesk-launch-"));
  directories.push(directory);
  const argvFile = join(directory, "argv");
  // Stands in for the CLI and records what it was actually given. NUL-separated, because the
  // prompt contains newlines and this test is about whether they stayed inside one argument.
  const stub = join(directory, "claude");
  await writeFile(stub, `#!/bin/sh\n: > "${argvFile}"\nfor a in "$@"; do printf '%s\\0' "$a" >> "${argvFile}"; done\n`);
  await chmod(stub, 0o755);

  const prompt = [
    "Read the brief: it's in `docs/`, costs $0, and has (parens).",
    'A "quoted" line; then a semicolon.',
    "Ends with a backslash \\ and a single quote '",
  ].join("\n");
  // The stub stands in for `claude` by absolute path rather than by PATH: the pane command runs
  // through a LOGIN shell, and this machine's profile replaces PATH outright, so anything exported
  // into the child environment is gone by the time the command runs. That is the same reason the
  // Justfile passes an absolute `bun` to the sidecar.
  const command = newClaudeSessionCommand({ sessionId: "abc", title: "OSS agent (fork 1)", prompt });
  command[0] = stub;
  const args = newSessionArgs({
    session: "agentdesk-test",
    cwd: directory,
    command,
    columns: 120,
    rows: 40,
  });
  // The last argument is the whole pane command: the string tmux hands to `/bin/sh -c`.
  const paneCommand = args.at(-1)!;

  const run = Bun.spawn(["/bin/sh", "-c", paneCommand], {
    cwd: directory,
    // The pane command ends in a login shell, which is there so a failure stays readable. With no
    // input it has nothing to read and exits, which is what lets this test finish.
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await run.exited;

  const received = (await readFile(argvFile, "utf8")).split("\0").slice(0, -1);
  expect(received).toEqual([...permission, "--session-id", "abc", "-n", "OSS agent (fork 1)", prompt]);
});

test("a first turn far past tmux's command limit reaches the CLI whole, through a file", async () => {
  // tmux refuses a command over about 16KB, and a handover is hundreds of kilobytes. The turn
  // rides in a file the pane reads, so what has to hold is that the CLI still receives it as one
  // byte-exact argument -- trailing newlines included, which command substitution would strip --
  // and that the file and its directory are gone once it has.
  const directory = await mkdtemp(join(tmpdir(), "agentdesk-launch-"));
  directories.push(directory);
  const argvFile = join(directory, "argv");
  const stub = join(directory, "claude");
  await writeFile(stub, `#!/bin/sh\n: > "${argvFile}"\nfor a in "$@"; do printf '%s\\0' "$a" >> "${argvFile}"; done\n`);
  await chmod(stub, 0o755);

  const line = 'it\'s `$HOME` and "$(rm -rf x)"; (fork 1) \\ end\n';
  const prompt = `${line.repeat(Math.ceil(300_000 / line.length))}\n\n`;
  const turnDirectory = join(directory, "turn");
  await mkdir(turnDirectory);
  const turnFile = join(turnDirectory, "turn.txt");
  await writeFile(turnFile, prompt);

  const command = newClaudeSessionCommand({ sessionId: "abc", title: "OSS agent" });
  command[0] = stub;
  const paneCommand = newSessionArgs({
    session: "agentdesk-test",
    cwd: directory,
    command: firstTurnFromFile(command, turnFile),
    columns: 120,
    rows: 40,
  }).at(-1)!;
  expect(paneCommand.length).toBeLessThan(16_000);

  const run = Bun.spawn(["/bin/sh", "-c", paneCommand], {
    cwd: directory,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await run.exited;

  const received = (await readFile(argvFile, "utf8")).split("\0").slice(0, -1);
  expect(received.slice(0, -1)).toEqual([...permission, "--session-id", "abc", "-n", "OSS agent"]);
  expect(received.at(-1)).toBe(prompt);
  expect(existsSync(turnDirectory)).toBe(false);
});

test("a reopened session the catalog does not know gets the same permission flags a fresh one does", () => {
  expect(resumeClaudeSessionCommand("abc")).toEqual(["claude", ...permission, "--resume", "abc"]);
});

test("a fork opens the way its source last ran, its brief still the last word", () => {
  const command = forkClaudeSessionCommand(
    { sessionId: "src", forkId: "fork", title: "Bot colours", brief: "try teal" },
    { model: "haiku", effort: "low", permissionMode: "plan" },
  );
  expect(command.slice(0, 3)).toEqual(["claude", "--permission-mode", "plan"]);
  expect(command.slice(command.indexOf("--fork-session"), -1)).toEqual([
    "--fork-session",
    "--session-id",
    "fork",
    "-n",
    "Bot colours",
    "--model",
    "haiku",
    "--effort",
    "low",
  ]);
  expect(command.at(-1)).toContain("try teal");
});

test("a reopened session resumes in the mode, model and effort it last ran with", () => {
  const command = resumeClaudeSessionCommand("abc", { model: "haiku", effort: "max", permissionMode: "plan" });
  expect(command.slice(0, 3)).toEqual(["claude", "--permission-mode", "plan"]);
  expect(command.slice(-6)).toEqual(["--resume", "abc", "--model", "haiku", "--effort", "max"]);
});

test("what a session resumes with is checked, and a runner's newer choice wins", () => {
  const last = { model: "claude-opus-5-5[1m]", effort: "high", permissionMode: "default" };
  expect(resumeSelection(last, {}, "auto")).toEqual({
    model: "claude-opus-5-5[1m]",
    effort: "high",
    permissionMode: "manual",
  });
  expect(resumeSelection(last, { model: "haiku", effort: "max" }, "auto")).toEqual({
    model: "haiku",
    effort: "max",
    permissionMode: "manual",
  });
  expect(resumeSelection({ model: "opus; rm -rf /", effort: "ultra", permissionMode: "sideways" }, {}, "auto")).toEqual(
    {},
  );
  expect(resumeSelection(undefined, {}, "auto")).toEqual({});
});

test("a mode read from the transcript never gives a session more than a fresh launch would", () => {
  // The transcript is writable by the session's own agent, so a line claiming bypass is not a choice.
  expect(resumeSelection({ permissionMode: "bypassPermissions" }, {}, "auto")).toEqual({});
  expect(resumeSelection({ permissionMode: "auto" }, {}, "manual")).toEqual({});
  for (const mode of ["plan", "dontAsk", "default", "acceptEdits", "auto"]) {
    expect(resumeSelection({ permissionMode: mode }, {}, "auto").permissionMode).toBeDefined();
  }
  expect(resumeSelection({ permissionMode: "bypassPermissions" }, {}, "bypassPermissions")).toEqual({
    permissionMode: "bypassPermissions",
  });
});

test("a fork's pane is named after the fork, so two forks of one session do not collide", () => {
  const first = claudeForkPaneName("0a9952cf-8338-46cf-bfd8-3f82e941b969");
  const second = claudeForkPaneName("22d3a140-d1b6-4eb2-a1a8-e069f07255fa");
  expect(first).toBe("agentdesk-fork-0a9952cf-8338-46cf-bfd8-3f82e941b969");
  expect(first).not.toBe(second);
});

test("a fork resumes its source and lands at its own id", () => {
  expect(forkClaudeSessionCommand({ sessionId: "src", forkId: "fork", title: "Bot colours" })).toEqual([
    "claude",
    ...permission,
    "--resume",
    "src",
    "--fork-session",
    "--session-id",
    "fork",
    "-n",
    "Bot colours",
  ]);
});

test("a fork given a brief is told whose work it is holding before it is told what to do", () => {
  const command = forkClaudeSessionCommand({
    sessionId: "src",
    forkId: "fork",
    title: "Bot colours",
    brief: "Give each Bot card its own background colour.",
  });
  const turn = command.at(-1)!;
  // The two halves that make this worth composing centrally: it says the context is borrowed, and
  // it says to leave the parent's unfinished work alone. Either without the other is the bug.
  expect(turn).toContain("You are a fork");
  expect(turn).toContain("the parent is");
  expect(turn.endsWith("Give each Bot card its own background colour.")).toBe(true);
  // One argument past the flags, not two: the brief is one positional, not the preamble plus the brief.
  expect(command).toHaveLength(9 + permission.length);
});

test("no brief means no first turn, so a fork opened to type into does not answer itself", () => {
  // The reader's own fork is the common case, and a preamble alone would be a turn spent saying
  // "you are a fork" to a session with nothing to do.
  const command = forkClaudeSessionCommand({ sessionId: "src", forkId: "fork", title: "x" });
  expect(command).toHaveLength(8 + permission.length);
});

test("a hostile fork brief arrives as exactly one argument, through the shells tmux uses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentdesk-fork-"));
  directories.push(directory);
  const argvFile = join(directory, "argv");
  const stub = join(directory, "claude");
  await writeFile(stub, `#!/bin/sh\n: > "${argvFile}"\nfor a in "$@"; do printf '%s\\0' "$a" >> "${argvFile}"; done\n`);
  await chmod(stub, 0o755);

  // The preamble itself contains an apostrophe and the brief adds the rest, so this exercises the
  // composed string rather than only the caller's half.
  const brief = "Don't touch the parent's files; it's `mid-edit` in (two) of them $HOME\\";
  const command = forkClaudeSessionCommand({
    sessionId: "src",
    forkId: "fork",
    title: "Bot colours (fork 1)",
    brief,
  });
  const expected = command.at(-1)!;
  command[0] = stub;
  const paneCommand = newSessionArgs({
    session: "agentdesk-fork-test",
    cwd: directory,
    command,
    columns: 120,
    rows: 40,
  }).at(-1)!;

  const run = Bun.spawn(["/bin/sh", "-c", paneCommand], {
    cwd: directory,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await run.exited;

  const received = (await readFile(argvFile, "utf8")).split("\0").slice(0, -1);
  expect(received).toEqual([
    ...permission,
    "--resume",
    "src",
    "--fork-session",
    "--session-id",
    "fork",
    "-n",
    "Bot colours (fork 1)",
    expected,
  ]);
  expect(expected).toBe(forkFirstTurn(brief));
});

function restartTmux(panes: { pane: string; command: string }[], stamped: string | null = "Work title") {
  const respawned: { pane: string; cwd: string; command: readonly string[] }[] = [];
  return {
    respawned,
    tmux: {
      stamped: async () => stamped,
      paneStarts: async () => panes,
      respawn: async (pane: string, cwd: string, command: readonly string[]) => {
        respawned.push({ pane, cwd, command });
      },
    },
  };
}

test("a restart runs the session's own pane again under today's launch flags", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const { respawned, tmux } = restartTmux([
    { pane: "%7", command: `/bin/zsh -l -c 'claude --resume ${id}; exec /bin/zsh -l'` },
  ]);
  expect(await restartClaudeSession({ sessionId: id, cwd: "/repo" }, tmux)).toEqual({ kind: "restarted", pane: "%7" });
  expect(respawned).toEqual([{ pane: "%7", cwd: "/repo", command: resumeClaudeSessionCommand(id) }]);
});

test("a pane somebody started by hand is refused, even when the stamp points at it", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const { respawned, tmux } = restartTmux([
    { pane: "%3", command: "" },
    { pane: "%4", command: "zsh" },
  ]);
  expect(await restartClaudeSession({ sessionId: id, cwd: "/repo" }, tmux)).toEqual({
    kind: "not-ours",
    session: "Work title",
  });
  expect(respawned).toEqual([]);
});

test("a session with no stamped pane has nothing to restart", async () => {
  const { respawned, tmux } = restartTmux([], null);
  expect(await restartClaudeSession({ sessionId: "11111111-2222-4333-8444-555555555555", cwd: "/repo" }, tmux)).toEqual(
    { kind: "no-pane" },
  );
  expect(respawned).toEqual([]);
});

test("a respawn targets the pane by id and runs the same script a new pane would", () => {
  const command = ["claude", "--resume", "x"];
  const created = newSessionArgs({ session: "s", cwd: "/repo", command, columns: 80, rows: 24 });
  expect(respawnPaneArgs("%7", "/repo", command)).toEqual([
    "respawn-pane",
    "-k",
    "-t",
    "%7",
    "-c",
    "/repo",
    created.at(-1)!,
  ]);
});
