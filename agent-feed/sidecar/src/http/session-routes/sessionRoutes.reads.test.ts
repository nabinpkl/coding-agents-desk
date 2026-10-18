// Reading a session through its routes without changing it: the last thing a person said, and a
// page of events around a position. Split from the session routes' main suite, which covers
// renaming and forking.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionRoutes } from "@/http/session-routes/sessionRoutes";
import {
  SessionRenameInvalidError,
  SessionRenameNotFoundError,
  SessionRenameUnavailableError,
} from "@/transcripts/session-ops/renameSession";
import { forkClaudeSession } from "@/transcripts/session-ops/forkSession";
import { sessionTitleRefusal } from "@/transcripts/session-ops/sessionTitle";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

const server = { timeout() {} } as never;

const roots: string[] = [];

const SESSION_ID = "33333333-3333-4333-8333-333333333333";

const FORK_ID = "22222222-2222-4222-8222-222222222222";

/**
 * The rename asks the session's own CLI to run `/rename`, so what a test can observe is what was
 * asked of it -- there is deliberately no file write to look for.
 */
const renamed: { sessionId: string; title: string }[] = [];

let outcome: { renamed: true } | { renamed: false; reason: string } = { renamed: true };

async function renameAction(sessionId: string, requestedTitle: string): Promise<string> {
  // The real refusals, because the route's job is turning each one into a status code.
  const title = requestedTitle.trim();
  const invalid = sessionTitleRefusal(title);
  if (invalid) throw new SessionRenameInvalidError(invalid);
  if (!state.sessions.has(sessionKey("claude", sessionId))) {
    throw new SessionRenameNotFoundError("session not found");
  }
  renamed.push({ sessionId, title });
  if (outcome.renamed) return title;
  throw new SessionRenameUnavailableError(
    outcome.reason === "composer-busy"
      ? "this session has unsent text in its composer; send or clear it and rename again"
      : "this session is not running, and only a running session can rename itself",
  );
}

/** What the fork's pane work was asked to do, and what it should answer. */
const rewound: { sessionId: string; fromEnd: number; text: string }[] = [];

let rewindOutcome: { done: true } | { done: false; reason: string } = { done: true };

/**
 * The fork asks the launch path to start a session, so what a test can observe is the argv-shaped
 * question it asked -- the pane itself is tmux's answer and is not made here.
 */
const forked: { cwd: string; sessionId: string; forkId: string; title: string; brief?: string }[] = [];

let forkFailure: Error | null = null;

/** The real fork, with only the two things that would touch a machine stood in for. */
const forkAction: typeof forkClaudeSession = (sessionId, command) => forkClaudeSession(
  sessionId,
  command,
  {
    start: async () => {
      throw new Error("a fork must never start a session with no history");
    },
    end: async () => {
      throw new Error("a fork must never end a session");
    },
    fork: async (options) => {
      forked.push(options);
      if (forkFailure) throw forkFailure;
      return { tmuxSession: `fork-pane-${options.forkId}` };
    },
  },
  () => FORK_ID,
  async ({ sessionId: forkId, anchor }) => {
    rewound.push({ sessionId: forkId, ...anchor });
    return rewindOutcome;
  },
);

const route = createSessionRoutes(undefined, { rename: renameAction, fork: forkAction });

afterEach(async () => {
  state.sessions.clear();
  state.watcherState = "idle";
  renamed.length = 0;
  outcome = { renamed: true };
  forked.length = 0;
  forkFailure = null;
  rewound.length = 0;
  rewindOutcome = { done: true };
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** One line of the transcript, as the CLI writes a person speaking. */
function said(root: string, text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    cwd: root,
    timestamp: "2026-09-09T05:00:00.000Z",
    uuid: crypto.randomUUID(),
  });
}

/** The same line, as the CLI writes the agent answering. */
function answered(root: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    cwd: root,
    timestamp: "2026-09-09T05:00:01.000Z",
    uuid: crypto.randomUUID(),
  });
}

/** A transcript the catalog knows about, holding whatever `lines` writes into it. */
async function transcriptHolding(
  lines: (root: string) => readonly string[],
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-rename-"));
  roots.push(root);
  const transcript = join(root, `${SESSION_ID}.jsonl`);
  await writeFile(transcript, `${lines(root).join("\n")}\n`);
  state.sessions.set(sessionKey("claude", SESSION_ID), {
    source: "claude",
    sessionId: SESSION_ID,
    project: root,
    transcriptPath: transcript,
    lastEventAt: 1_000,
  });
}

/**
 * A transcript holding two things a person said.
 *
 * The rename needs only the catalog row; forking from a message needs the file to have messages
 * in it, because the anchor is resolved by reading them.
 */
async function sessionTranscript(): Promise<void> {
  await transcriptHolding((root) => [said(root, "ALPHA one"), said(root, "BRAVO two")]);
}

/** The reason a refusal gave, which is the half of it a reader can act on. */
async function errorMessage(response: Response): Promise<string> {
  const payload = await response.json() as { error?: { message?: string } };
  return payload.error?.message ?? "";
}

function lastMessage(source: string, sessionId: string, query = ""): Promise<Response> {
  const request = new Request(`http://localhost/api/sessions/${source}/${sessionId}/last-message${query}`);
  return Promise.resolve(route(request, new URL(request.url), server) as Promise<Response>);
}

test("answers the newest message a person wrote, addressed the way a fork takes it", async () => {
  // The row a reader would have had to scroll to. BRAVO is the newest of the two, and the id is
  // the one `ForkSessionCommand.from` names -- so the answer goes straight back as a fork.
  state.watcherState = "live";
  await sessionTranscript();

  const response = await lastMessage("claude", SESSION_ID);
  // BRAVO's line starts one past the end of ALPHA's.
  const path = state.sessions.get(`claude:${SESSION_ID}`)!.transcriptPath!;
  const alpha = (await Bun.file(path).text()).split("\n")[0]!;

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    eventId: `claude:${SESSION_ID}:at:${Buffer.byteLength(alpha) + 1}`,
    index: Buffer.byteLength(alpha) + 1,
    text: "BRAVO two",
  });
});

test("skips everything that is not a person talking", async () => {
  // The scar this whole flag exists for: an answer, and a `<system-reminder>` the harness wrote as
  // the user. Neither is a row the rewind picker lists, so neither can anchor a fork.
  state.watcherState = "live";
  await transcriptHolding((root) => [
    said(root, "ALPHA one"),
    answered(root, "BRAVO two"),
    said(root, "<system-reminder>a note nobody typed</system-reminder>"),
  ]);

  expect(await (await lastMessage("claude", SESSION_ID)).json()).toEqual({
    eventId: `claude:${SESSION_ID}:at:0`,
    index: 0,
    text: "ALPHA one",
  });
});

test("passes over a bare slash command when asked for the last thing said", async () => {
  // The user bar asks this way. Asked without it, a session whose newest message was `/compact`
  // answered with that, the bar refused it as a command, and showed nothing.
  state.watcherState = "live";
  await transcriptHolding((root) => [said(root, "ALPHA one"), said(root, "/compact")]);

  expect(await (await lastMessage("claude", SESSION_ID)).json()).toMatchObject({ text: "/compact" });
  expect(await (await lastMessage("claude", SESSION_ID, "?said=1")).json()).toEqual({
    eventId: `claude:${SESSION_ID}:at:0`,
    index: 0,
    text: "ALPHA one",
  });
});

test("asked for the last thing said before a position, walks back from there", async () => {
  // The bar asks from the start of the rows it holds, so a message below that start is one it
  // already has, and the answer it needs is the one above.
  state.watcherState = "live";
  await transcriptHolding((root) => [said(root, "ALPHA one"), answered(root, "ok"), said(root, "BRAVO two")]);
  const path = state.sessions.get(`claude:${SESSION_ID}`)!.transcriptPath!;
  const [alpha, ok] = (await Bun.file(path).text()).split("\n");
  const bravo = Buffer.byteLength(alpha!) + 1 + Buffer.byteLength(ok!) + 1;

  expect(await (await lastMessage("claude", SESSION_ID, `?before=${bravo}&said=1`)).json()).toEqual({
    eventId: `claude:${SESSION_ID}:at:0`,
    index: 0,
    text: "ALPHA one",
  });
  expect((await lastMessage("claude", SESSION_ID, "?before=0")).status).toBe(404);
  expect((await lastMessage("claude", SESSION_ID, "?before=3")).status).toBe(400);
  expect((await lastMessage("claude", SESSION_ID, "?before=x")).status).toBe(400);
});

function eventsPage(query: string): Promise<Response> {
  const request = new Request(`http://localhost/api/sessions/claude/${SESSION_ID}/events?${query}`);
  return Promise.resolve(route(request, new URL(request.url), server) as Promise<Response>);
}

test("reads a page before, after or around a position, and refuses two at once", async () => {
  state.watcherState = "live";
  await transcriptHolding((root) => Array.from({ length: 9 }, (_, turn) => answered(root, `turn ${turn}`)));
  const lines = (await Bun.file(state.sessions.get(`claude:${SESSION_ID}`)!.transcriptPath!).text()).split("\n");
  const starts = lines.map((_, n) => lines.slice(0, n).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0));
  const texts = async (response: Response) =>
    ((await response.json()) as { events: { blocks: { text?: string }[] }[] }).events.map((event) =>
      event.blocks.find((block) => block.text)?.text);

  expect(await texts(await eventsPage(`after=${starts[2]}&limit=3`))).toEqual(["turn 3", "turn 4", "turn 5"]);
  expect(await texts(await eventsPage(`around=${starts[4]}&limit=4`))).toEqual(["turn 2", "turn 3", "turn 4", "turn 5"]);
  expect(await texts(await eventsPage(`before=${starts[2]}&limit=5`))).toEqual(["turn 0", "turn 1"]);
  expect((await eventsPage(`after=1&before=2`)).status).toBe(400);
  expect((await eventsPage(`around=${starts[4]! + 1}`)).status).toBe(400);
});

test("says so when nobody has written a message yet", async () => {
  // 404 with a reason rather than an empty body: the caller opens a dialog quoting this, and an
  // empty quote would read as a message that says nothing.
  state.watcherState = "live";
  await transcriptHolding((root) => [answered(root, "nobody asked me anything")]);

  const response = await lastMessage("claude", SESSION_ID);

  expect(response.status).toBe(404);
  expect(await errorMessage(response)).toMatch(/nobody has written/);
});

test("answers 404 for a session the catalog does not hold, and 503 before it is read", async () => {
  state.watcherState = "live";
  expect((await lastMessage("claude", "44444444-4444-4444-8444-444444444444")).status).toBe(404);
  state.watcherState = "idle";
  await sessionTranscript();
  expect((await lastMessage("claude", SESSION_ID)).status).toBe(503);
});

test("declines a Codex path, which has no fork to feed", async () => {
  state.watcherState = "live";
  const request = new Request(`http://localhost/api/sessions/codex/${SESSION_ID}/last-message`);
  // Not undefined: `/api/sessions/...` with an unrecognized shape is this handler's 400, and that
  // is what the existing GET routes answer too.
  const response = await route(request, new URL(request.url), server) as Response;
  expect(response.status).toBe(400);
});
