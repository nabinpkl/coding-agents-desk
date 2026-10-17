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
import { forgetWorktrees, WorktreeError } from "@/git/worktree";
import {
  forkClaudeSession,
  launchSession,
  MAX_LAUNCH_PROMPT,
  SessionForkInvalidError,
  SessionForkNotFoundError,
  type ForkRewinder,
  type SessionLauncher,
} from "@/transcripts/session-ops/forkSession";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

const roots: string[] = [];
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const FORK_ID = "66666666-6666-4666-8666-666666666666";

type Asked =
  | { kind: "start"; cwd: string; sessionId: string; title: string; prompt?: string; mode?: string }
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
  async end() {
    throw new Error("nothing here ends a session");
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

/** That session's transcript on disk: two messages, with an assistant reply between them. */
async function withTranscript(project: string, sessionId = SESSION_ID): Promise<void> {
  const said = (text: string) => JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    cwd: project,
    timestamp: "2026-09-09T05:00:00.000Z",
    uuid: crypto.randomUUID(),
  });
  const replied = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "OK" }] },
    cwd: project,
    timestamp: "2026-09-09T05:00:02.000Z",
    uuid: crypto.randomUUID(),
  });
  await writeFile(
    join(project, `${sessionId}.jsonl`),
    `${[said("ALPHA one"), replied, said("BRAVO two"), replied].join("\n")}\n`,
  );
}

/** The id a page gives line `n` of the session's transcript: the byte that line starts at. */
async function rowId(project: string, n: number, sessionId = SESSION_ID): Promise<string> {
  const lines = (await Bun.file(join(project, `${sessionId}.jsonl`)).text()).split("\n");
  const position = lines.slice(0, n).reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, 0);
  return `claude:${sessionId}:at:${position}`;
}

/** A rewinder that records what it was asked for and answers however the test says. */
function rewinderThat(
  answer: { done: true } | { done: false; reason: string },
): ForkRewinder & { asked: { sessionId: string; anchor: unknown; prompt?: string }[] } {
  const asked: { sessionId: string; anchor: unknown; prompt?: string }[] = [];
  const rewinder: ForkRewinder = async (options) => {
    asked.push(options);
    return answer;
  };
  return Object.assign(rewinder, { asked });
}

/** A rewinder no test expects to run. */
const neverRewinds: ForkRewinder = async () => {
  throw new Error("nothing named a message, so nothing should have been rewound");
};

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

test("a launch asked for in SDK mode passes the mode to the starter, and a fork asking for it is refused", async () => {
  const checkout = await directory();
  await launchSession({ checkout, title: "Fresh", claudeMode: "sdk" }, launcher, newForkId);
  expect(asked).toEqual([
    { kind: "start", cwd: checkout, sessionId: FORK_ID, title: "Fresh", prompt: undefined, mode: "sdk" },
  ]);
  await expect(launchSession(
    { checkout, from: SESSION_ID, title: "Branch", claudeMode: "sdk", worktree: {} },
    launcher,
    newForkId,
  )).rejects.toBeInstanceOf(SessionForkInvalidError);
  // Refused before a worktree is cut or anything is started.
  expect(asked).toHaveLength(1);
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

test("starts the fork at a named message, and holds the brief back for after the rewind", async () => {
  // The CLI takes a positional prompt as the session's first turn, which would run it against the
  // whole inherited context -- the exact thing the rewind exists to avoid.
  const project = await directory();
  knownSession(project);
  await withTranscript(project);
  const rewinder = rewinderThat({ done: true });

  const started = await forkClaudeSession(
    SESSION_ID,
    { title: "From BRAVO", prompt: "the sibling task", from: { eventId: await rowId(project, 2) } },
    launcher,
    newForkId,
    rewinder,
  );

  expect(started.rewindFailed).toBeUndefined();
  expect(asked[0]).toMatchObject({ kind: "fork", brief: undefined });
  expect(rewinder.asked).toEqual([{
    sessionId: FORK_ID,
    anchor: { fromEnd: 1, text: "BRAVO two" },
    prompt: "the sibling task",
  }]);
});

test("counts the message back from the newest, not from the top of the file", async () => {
  const project = await directory();
  knownSession(project);
  await withTranscript(project);
  const rewinder = rewinderThat({ done: true });

  await forkClaudeSession(
    SESSION_ID,
    { title: "From ALPHA", from: { eventId: await rowId(project, 0) } },
    launcher,
    newForkId,
    rewinder,
  );

  expect(rewinder.asked[0]?.anchor).toEqual({ fromEnd: 2, text: "ALPHA one" });
});

test("says when the fork could not be moved, and hands back the fork anyway", async () => {
  // The session exists either way. A caller told only that the request failed would not know
  // there was now one running that holds more than it asked for.
  const project = await directory();
  knownSession(project);
  await withTranscript(project);

  const started = await forkClaudeSession(
    SESSION_ID,
    { title: "Doomed", from: { eventId: await rowId(project, 2) } },
    launcher,
    newForkId,
    rewinderThat({ done: false, reason: "rewind refused: no-picker" }),
  );

  expect(started).toMatchObject({
    sessionId: FORK_ID,
    tmuxSession: `fork-pane-${FORK_ID}`,
    rewindFailed: "rewind refused: no-picker",
  });
});

test("a fork that named no message is not rewound, and its brief rides the launch", async () => {
  const project = await directory();
  knownSession(project);

  await forkClaudeSession(
    SESSION_ID,
    { title: "Whole thing", prompt: "carry on" },
    launcher,
    newForkId,
    neverRewinds,
  );

  expect(asked[0]).toMatchObject({ kind: "fork", brief: "carry on" });
});

test("refuses a row that is not a message before anything is started", async () => {
  // Resolved ahead of the launch on purpose: the alternative is answering a bad anchor with a
  // running fork that holds the whole conversation.
  const project = await directory();
  knownSession(project);
  await withTranscript(project);

  // The assistant line, and a position past the end of the file.
  for (const eventId of [await rowId(project, 1), `claude:${SESSION_ID}:at:99999`]) {
    await expect(forkClaudeSession(
      SESSION_ID,
      { title: "No", from: { eventId } },
      launcher,
      newForkId,
      neverRewinds,
    )).rejects.toBeInstanceOf(SessionForkInvalidError);
  }
  expect(asked).toEqual([]);
});

test("refuses an event that belongs to another session", async () => {
  const project = await directory();
  knownSession(project);
  await withTranscript(project);

  const refused = forkClaudeSession(
    SESSION_ID,
    { title: "No", from: { eventId: "claude:11111111-1111-4111-8111-111111111111:at:0" } },
    launcher,
    newForkId,
    neverRewinds,
  );

  await expect(refused).rejects.toBeInstanceOf(SessionForkInvalidError);
  expect(asked).toEqual([]);
});
