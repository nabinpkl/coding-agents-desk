// "Has this session ever worked here", which is what attaching a session to a Bot asks.
//
// The case these exist for is a project renamed under a running session: the catalog then files
// the session wherever its agent last ran a command, so asking it alone answered yes or no
// depending on the second. The transcript remembers every directory the session stood in, and
// that set only grows.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import { sessionWorkedIn, visitedDirectories } from "@/bots/sessions/botSessionHistory";
import { botRegistryHarness } from "@/bots/botRegistryHarness";

const { checkoutWithWorktree } = botRegistryHarness();

const created: string[] = [];

afterEach(async () => {
  for (const directory of created.splice(0)) {
    if (!directory.includes("agentdesk-history-")) throw new Error(`refusing to delete ${directory}`);
    await rm(directory, { recursive: true, force: true });
  }
});

/** A canonical scratch directory holding a Bot checkout, a stand-in scratchpad and a transcript. */
async function world() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agentdesk-history-")));
  created.push(root);
  const checkout = join(root, "reposhape");
  const scratchpad = join(root, "scratchpad");
  await Promise.all([mkdir(join(checkout, "backend"), { recursive: true }), mkdir(scratchpad)]);
  return { root, checkout, scratchpad };
}

/** A transcript whose records stood in `cwds`, in order, with some noise between them. */
async function transcript(root: string, cwds: string[], extra: string[] = []): Promise<string> {
  const path = join(root, "session.jsonl");
  const lines = cwds.map((cwd) => JSON.stringify({ type: "user", cwd, message: { content: "hi" } }));
  await writeFile(path, [...lines, ...extra].join("\n") + "\n");
  return path;
}

const SUMMARY = { sessionId: "s", source: "claude", lastEventAt: 0 } as SessionSummary;

describe("visitedDirectories", () => {
  test("is every directory the session stood in, once each", async () => {
    const { root, checkout, scratchpad } = await world();
    const path = await transcript(root, [checkout, scratchpad, checkout, scratchpad]);
    expect(await visitedDirectories(path)).toEqual(new Set([checkout, scratchpad]));
  });

  test("does not read a `cwd` out of a tool's output, which is escaped inside a string", async () => {
    const { root, checkout } = await world();
    const output = JSON.stringify({ type: "user", toolUseResult: `{"cwd":"/somewhere/else"}` });
    const path = await transcript(root, [checkout], [output]);
    expect(await visitedDirectories(path)).toEqual(new Set([checkout]));
  });

  test("decodes an escaped path rather than comparing its escape", async () => {
    const { root } = await world();
    const odd = join(root, 'say "hi"');
    const path = await transcript(root, [odd]);
    expect(await visitedDirectories(path)).toEqual(new Set([odd]));
  });

  test("is empty for a transcript that is not there, rather than throwing", async () => {
    const { root } = await world();
    expect(await visitedDirectories(join(root, "gone.jsonl"))).toEqual(new Set());
  });
});

describe("sessionWorkedIn", () => {
  test("a session the catalog files in the Bot's directory needs no transcript read", async () => {
    const { root, checkout } = await world();
    const session = { projectPath: checkout, summary: SUMMARY, transcriptPath: join(root, "gone.jsonl") };
    expect(await sessionWorkedIn(session, checkout)).toBe(true);
  });

  test("a session whose agent is in its scratchpad right now still worked in the Bot's directory", async () => {
    // The renamed-project case, as it was measured: the catalog says scratchpad, the history says
    // the session spent most of its life in the checkout.
    const { root, checkout, scratchpad } = await world();
    const path = await transcript(root, [join(root, "import-graph"), checkout, scratchpad]);
    const session = { projectPath: scratchpad, summary: SUMMARY, transcriptPath: path };
    expect(await sessionWorkedIn(session, checkout)).toBe(true);
  });

  test("a session that never stood in the Bot's directory is refused", async () => {
    const { root, checkout, scratchpad } = await world();
    const path = await transcript(root, [scratchpad, join(root, "import-graph")]);
    const session = { projectPath: scratchpad, summary: SUMMARY, transcriptPath: path };
    expect(await sessionWorkedIn(session, checkout)).toBe(false);
  });

  test("a subdirectory is not the Bot's directory, the same rule the Bot uses everywhere else", async () => {
    // Looser here than there would let a session attach that the Bot would not otherwise count as
    // its own; and with `cd ..` in its history, a session would be claimable by the parent's Bot.
    const { root, checkout, scratchpad } = await world();
    const path = await transcript(root, [join(checkout, "backend"), scratchpad]);
    const session = { projectPath: scratchpad, summary: SUMMARY, transcriptPath: path };
    expect(await sessionWorkedIn(session, checkout)).toBe(false);
  });

  test("a git worktree of the Bot's checkout in the history counts, as it does everywhere else", async () => {
    const { checkout, worktree } = await checkoutWithWorktree();
    const { root, scratchpad } = await world();
    const path = await transcript(root, [worktree, scratchpad]);
    const session = { projectPath: scratchpad, summary: SUMMARY, transcriptPath: path };
    expect(await sessionWorkedIn(session, checkout)).toBe(true);
  });

  test("a source with no transcript answers from the catalog alone", async () => {
    const { checkout, scratchpad } = await world();
    const session = { projectPath: scratchpad, summary: SUMMARY };
    expect(await sessionWorkedIn(session, checkout)).toBe(false);
  });
});
