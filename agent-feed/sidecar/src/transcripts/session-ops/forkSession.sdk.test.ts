// A fork through the Agent SDK (ADR-0143): it starts already cut at the message it was asked to
// start before, so there is no rewind to drive, and its brief rides as its first turn. Beside
// `forkSession.test.ts` rather than in it, which was at the line cap.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  forkClaudeSession,
  launchSession,
  SessionForkInvalidError,
  type ForkRewinder,
  type SessionLauncher,
} from "@/transcripts/session-ops/forkSession";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

const roots: string[] = [];
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const FORK_ID = "66666666-6666-4666-8666-666666666666";

let asked: Record<string, unknown>[] = [];

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

/** An SDK fork is never rewound; a rewinder that runs is the failure. */
const neverRewinds: ForkRewinder = async () => {
  throw new Error("an SDK fork starts already cut, so nothing should have been rewound");
};

afterEach(async () => {
  asked = [];
  state.sessions.clear();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "fork-session-sdk-"));
  roots.push(created);
  return realpath(created);
}

/** The id a page gives line `n` of the session's transcript: the byte that line starts at. */
async function rowId(project: string, n: number): Promise<string> {
  const lines = (await Bun.file(join(project, `${SESSION_ID}.jsonl`)).text()).split("\n");
  const position = lines.slice(0, n).reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, 0);
  return `claude:${SESSION_ID}:at:${position}`;
}

test("an SDK fork from a message starts already cut there, its brief riding along, and is never rewound", async () => {
  const checkout = await directory();
  const started = await launchSession(
    {
      checkout,
      from: SESSION_ID,
      anchor: { fromEnd: 2, text: "BRAVO two", forkPoint: "uuid-before-bravo" },
      title: "Branch",
      prompt: "take the other road",
      claudeMode: "sdk",
    },
    launcher,
    newForkId,
    neverRewinds,
  );
  expect(asked).toEqual([{
    kind: "fork",
    cwd: checkout,
    sessionId: SESSION_ID,
    forkId: FORK_ID,
    title: "Branch",
    brief: "take the other road",
    mode: "sdk",
    resumeAt: "uuid-before-bravo",
  }]);
  expect(started.rewindFailed).toBeUndefined();
});

test("an SDK fork from the first message is refused before anything is started", async () => {
  const checkout = await directory();
  await expect(launchSession(
    { checkout, from: SESSION_ID, anchor: { fromEnd: 1, text: "ALPHA one" }, title: "Branch", claudeMode: "sdk", worktree: {} },
    launcher,
    newForkId,
    neverRewinds,
  )).rejects.toBeInstanceOf(SessionForkInvalidError);
  expect(asked).toEqual([]);
});

test("a fork of a session that last ran through the SDK runs through it too, cut before the named message", async () => {
  const project = await directory();
  state.sessions.set(sessionKey("claude", SESSION_ID), {
    source: "claude",
    sessionId: SESSION_ID,
    project,
    transcriptPath: join(project, `${SESSION_ID}.jsonl`),
    lastEventAt: 1_000,
    lastEntrypoint: "sdk-cli",
  });
  const line = (uuid: string, parentUuid: string | null, type: "user" | "assistant", text: string) => JSON.stringify({
    type,
    uuid,
    parentUuid,
    cwd: project,
    timestamp: "2026-10-17T05:00:00.000Z",
    message: type === "user" ? { role: "user", content: text } : { role: "assistant", content: [{ type: "text", text }] },
  });
  await writeFile(join(project, `${SESSION_ID}.jsonl`), `${[
    line("u1", null, "user", "ALPHA one"),
    line("u2", "u1", "assistant", "OK"),
    line("u3", "u2", "user", "BRAVO two"),
    line("u4", "u3", "assistant", "OK"),
  ].join("\n")}\n`);

  const started = await forkClaudeSession(
    SESSION_ID,
    { title: "From BRAVO", prompt: "the sibling task", from: { eventId: await rowId(project, 2) } },
    launcher,
    newForkId,
    neverRewinds,
  );

  expect(started.rewindFailed).toBeUndefined();
  expect(asked).toEqual([expect.objectContaining({
    kind: "fork",
    mode: "sdk",
    resumeAt: "u2",
    brief: "the sibling task",
  })]);
});
