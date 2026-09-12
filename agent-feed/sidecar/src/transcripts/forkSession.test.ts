// The four decisions a launch makes, pinned against a stand-in launcher rather than tmux: which
// directory it runs in, whether it starts empty or from another session's context, what its first
// turn is, and which pane it lands in. The last of those is the launcher's own answer, so what is
// asserted here is that the right launcher was asked the right question.
//
// The worktree cases run real `git worktree add`, for the reason `worktree.test.ts` gives: what is
// being pinned is agreement with git, and a fixture would agree with whoever wrote it.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetWorktrees, WorktreeError } from "../git/worktree.ts";
import {
  forkClaudeSession,
  launchSession,
  MAX_LAUNCH_PROMPT,
  SessionForkInvalidError,
  SessionForkNotFoundError,
  type SessionLauncher,
} from "./forkSession.ts";
import { sessionKey } from "./transcriptCatalog.ts";
import { state } from "./transcriptState.ts";

const roots: string[] = [];
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const FORK_ID = "66666666-6666-4666-8666-666666666666";

type Asked =
  | { kind: "start"; cwd: string; sessionId: string; title: string; prompt?: string }
  | { kind: "fork"; cwd: string; sessionId: string; forkId: string; title: string; brief?: string };

let asked: Asked[] = [];

const launcher: SessionLauncher = {
  async start(options) {
    asked.push({ kind: "start", ...options });
    return { tmuxSession: `pane-${options.sessionId}` };
  },
  async fork(options) {
    asked.push({ kind: "fork", ...options });
    return { tmuxSession: `fork-pane-${options.forkId}` };
  },
};

const newForkId = () => FORK_ID;

afterEach(async () => {
  asked = [];
  forgetWorktrees();
  state.sessions.clear();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "fork-session-"));
  roots.push(created);
  // Canonical, because `/tmp` is a symlink on macOS and git records the resolved path.
  return realpath(created);
}

async function repository(): Promise<string> {
  const root = await directory();
  const checkout = join(root, "checkout");
  await run(["git", "init", "-q", "-b", "main", checkout], root);
  await writeFile(join(checkout, "README"), "x\n");
  await run(["git", "add", "README"], checkout);
  await run(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"], checkout);
  // The path a fork's worktree lands in has to be ignored, or `prepareWorktree` refuses it.
  await writeFile(join(checkout, ".git", "info", "exclude"), ".claude/worktrees/\n");
  return checkout;
}

async function run(command: string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "ignore" });
  const code = await process.exited;
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}`);
}

/** A session the catalog knows about, which is all a fork needs from it. */
function knownSession(project: string, sessionId = SESSION_ID): void {
  state.sessions.set(sessionKey("claude", sessionId), {
    source: "claude",
    sessionId,
    project,
    transcriptPath: join(project, `${sessionId}.jsonl`),
    lastEventAt: 1_000,
  });
}

test("a launch with no source starts an empty session in the checkout", async () => {
  const checkout = await directory();

  const started = await launchSession(
    { checkout, title: "Fresh", prompt: "do the thing" },
    launcher,
    newForkId,
  );

  expect(asked).toEqual([
    { kind: "start", cwd: checkout, sessionId: FORK_ID, title: "Fresh", prompt: "do the thing" },
  ]);
  expect(started).toEqual({
    sessionId: FORK_ID,
    title: "Fresh",
    projectPath: checkout,
    tmuxSession: `pane-${FORK_ID}`,
  });
});

test("a fork runs where its source runs, not where its repository is", async () => {
  // The case this exists for: a session already working in a worktree forks inside that worktree
  // rather than being pulled back into the checkout it branched away from.
  const checkout = await directory();
  const elsewhere = await directory();

  await launchSession(
    { checkout, sourcePath: elsewhere, from: SESSION_ID, title: "Branch", prompt: "sibling task" },
    launcher,
    newForkId,
  );

  expect(asked).toEqual([
    {
      kind: "fork",
      cwd: elsewhere,
      sessionId: SESSION_ID,
      forkId: FORK_ID,
      title: "Branch",
      brief: "sibling task",
    },
  ]);
});

test("asking for a worktree overrides where the source runs", async () => {
  // A tree of its own is the whole point of the request, so it outranks "stay where the source is".
  const checkout = await repository();
  const elsewhere = await directory();

  const started = await launchSession(
    { checkout, sourcePath: elsewhere, from: SESSION_ID, title: "Its own tree", worktree: {} },
    launcher,
    newForkId,
  );

  expect(started.projectPath).toBe(join(checkout, ".claude", "worktrees", "its-own-tree"));
  expect(asked[0]).toMatchObject({ kind: "fork", cwd: started.projectPath });
});

test("a worktree takes the branch it was given rather than one from the title", async () => {
  const checkout = await repository();

  const started = await launchSession(
    { checkout, title: "Anything at all", worktree: { branch: "chosen-name" } },
    launcher,
    newForkId,
  );

  expect(started.projectPath).toBe(join(checkout, ".claude", "worktrees", "chosen-name"));
});

test("git's refusal comes out unmapped, for each caller to say in its own words", async () => {
  const checkout = await repository();
  await run(["git", "branch", "taken"], checkout);

  const refused = launchSession(
    { checkout, title: "Fork", worktree: { branch: "taken" } },
    launcher,
    newForkId,
  );

  await expect(refused).rejects.toBeInstanceOf(WorktreeError);
  expect(asked).toEqual([]);
});

test("forking a session names its source and inherits its directory", async () => {
  const project = await directory();
  knownSession(project);

  const started = await forkClaudeSession(
    SESSION_ID,
    { title: "  What I called it  ", prompt: "  the sibling task  " },
    launcher,
    newForkId,
  );

  expect(started).toEqual({
    sessionId: FORK_ID,
    title: "What I called it",
    projectPath: project,
    tmuxSession: `fork-pane-${FORK_ID}`,
  });
  expect(asked).toEqual([
    {
      kind: "fork",
      cwd: project,
      sessionId: SESSION_ID,
      forkId: FORK_ID,
      title: "What I called it",
      brief: "the sibling task",
    },
  ]);
});

test("a fork with no prompt is given none, rather than an empty one", async () => {
  // A fork opened with no brief is a reader branching a session to type into it themselves, and an
  // injected first turn there would spend a turn answering nobody.
  const project = await directory();
  knownSession(project);

  await forkClaudeSession(SESSION_ID, { title: "Quiet", prompt: "   " }, launcher, newForkId);

  expect(asked[0]).toMatchObject({ kind: "fork", brief: undefined });
});

test("a fork of a session inside a worktree cuts its own tree from the main checkout", async () => {
  // Nesting is the failure this prevents: `git worktree add` run inside a worktree still belongs to
  // the one repository, so cutting from the worktree's own path would put a checkout inside a
  // checkout.
  const checkout = await repository();
  const inside = join(checkout, ".claude", "worktrees", "source-tree");
  await run(["git", "worktree", "add", "-q", "-b", "source-tree", inside], checkout);
  knownSession(inside);

  const started = await forkClaudeSession(SESSION_ID, { title: "Second", worktree: {} }, launcher, newForkId);

  expect(started.projectPath).toBe(join(checkout, ".claude", "worktrees", "second"));
});

test("refuses a title that cannot be one argument of one command", async () => {
  const project = await directory();
  knownSession(project);

  for (const title of ["   ", "one\ntwo", "x".repeat(241)]) {
    await expect(forkClaudeSession(SESSION_ID, { title }, launcher, newForkId))
      .rejects.toBeInstanceOf(SessionForkInvalidError);
  }
  // Refused before anything was started.
  expect(asked).toEqual([]);
});

test("refuses a first turn longer than a first turn", async () => {
  const project = await directory();
  knownSession(project);

  const refused = forkClaudeSession(
    SESSION_ID,
    { title: "Long", prompt: "x".repeat(MAX_LAUNCH_PROMPT + 1) },
    launcher,
    newForkId,
  );

  await expect(refused).rejects.toBeInstanceOf(SessionForkInvalidError);
  expect(asked).toEqual([]);
});

test("refuses a session the catalog does not hold", async () => {
  const refused = forkClaudeSession(SESSION_ID, { title: "Nowhere" }, launcher, newForkId);
  await expect(refused).rejects.toBeInstanceOf(SessionForkNotFoundError);
  expect(asked).toEqual([]);
});

test("does not need the source to be running", async () => {
  // Unlike renaming, which can only be asked of a live process: a fork reads the transcript the
  // source wrote, and nothing about that depends on a pane still holding it.
  const project = await directory();
  knownSession(project);

  await expect(forkClaudeSession(SESSION_ID, { title: "Cold source" }, launcher, newForkId))
    .resolves.toMatchObject({ sessionId: FORK_ID });
});
