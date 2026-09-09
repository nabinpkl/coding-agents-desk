// What is worth pinning here is not the shape of the argv -- it is that the argv survives.
//
// This command is built as a list, flattened into one string, handed to `/bin/sh -c` by tmux, and
// split back into arguments by a shell that has never heard of it. That round trip has already
// cost this repo an evening once, when a title containing `(fork 1)` reached zsh and came back as
// `invalid mode specification`. A launch prompt is the same argument only much longer and much
// more hostile, so the test that matters runs it through the real shells and reads the argv that
// arrives.

import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessionPaneName, newClaudeSessionCommand } from "./claudeSessionLaunch.ts";
import { newSessionArgs } from "./tmuxSessions.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("the pane name is the session id, so a second viewer lands on the first's pane", () => {
  expect(claudeSessionPaneName("0a9952cf-8338-46cf-bfd8-3f82e941b969"))
    .toBe("agentdesk-0a9952cf-8338-46cf-bfd8-3f82e941b969");
});

test("the command names the session and its title, and carries a prompt as the first turn", () => {
  expect(newClaudeSessionCommand({ sessionId: "abc", title: "OSS agent", prompt: "read AGENTS.md" }))
    .toEqual(["claude", "--session-id", "abc", "-n", "OSS agent", "read AGENTS.md"]);
});

test("no prompt means no trailing argument, not an empty one", () => {
  // An empty positional would be a first turn of nothing, which the CLI answers.
  expect(newClaudeSessionCommand({ sessionId: "abc", title: "OSS agent" }))
    .toEqual(["claude", "--session-id", "abc", "-n", "OSS agent"]);
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
  expect(received).toEqual(["--session-id", "abc", "-n", "OSS agent (fork 1)", prompt]);
});
