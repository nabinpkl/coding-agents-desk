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
 * Both routes are given their action rather than reaching for it, and nothing here replaces a
 * module.
 *
 * `mock.module` is global for a whole `bun test` run, so standing in for the composer here would
 * answer the composer's OWN tests too -- measured, nineteen of them, passing for the wrong reason.
 * Injection is what every other seam in this sidecar does.
 */

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

function rename(sessionId: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost/api/sessions/claude/${sessionId}/title`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return Promise.resolve(route(request, new URL(request.url), server) as Promise<Response>);
}

test("renaming asks the session to rename itself", async () => {
  state.watcherState = "live";
  await sessionTranscript();

  const response = await rename(SESSION_ID, { title: "  What I called it  " });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sessionId: SESSION_ID, title: "What I called it" });
  expect(renamed).toEqual([{ sessionId: SESSION_ID, title: "What I called it" }]);
});

test("says a session with unsent text was not renamed, and why", async () => {
  // A conflict rather than a bad request: nothing about the ask was wrong, and the same ask works
  // once the composer is clear.
  state.watcherState = "live";
  await sessionTranscript();
  outcome = { renamed: false, reason: "composer-busy" };

  const response = await rename(SESSION_ID, { title: "New name" });

  expect(response.status).toBe(409);
  expect(await errorMessage(response)).toMatch(/unsent text/);
});

test("says a session that is not running cannot rename itself", async () => {
  // There is deliberately no fallback to writing the transcript: that would move the title and
  // leave the address behind, which reads as a rename that worked and did not.
  state.watcherState = "live";
  await sessionTranscript();
  outcome = { renamed: false, reason: "no-pane" };

  const response = await rename(SESSION_ID, { title: "New name" });

  expect(response.status).toBe(409);
  expect(await errorMessage(response)).toMatch(/not running/);
});

test("refuses a title that cannot be one line of one command", async () => {
  state.watcherState = "live";
  await sessionTranscript();

  expect((await rename(SESSION_ID, { title: "   " })).status).toBe(400);
  expect((await rename(SESSION_ID, { title: "one\ntwo" })).status).toBe(400);
  expect((await rename(SESSION_ID, { title: "x".repeat(241) })).status).toBe(400);
  expect((await rename(SESSION_ID, { title: 7 })).status).toBe(400);
  // Refused before anything was asked of the session.
  expect(renamed).toEqual([]);
});

test("answers 404 for a session the catalog does not hold", async () => {
  state.watcherState = "live";
  const response = await rename("44444444-4444-4444-8444-444444444444", { title: "Anything" });
  expect(response.status).toBe(404);
  expect(renamed).toEqual([]);
});

test("declines a Codex rename rather than answering for a name it cannot change", async () => {
  state.watcherState = "live";
  const request = new Request(
    `http://localhost/api/sessions/codex/${SESSION_ID}/title`,
    { method: "POST", body: JSON.stringify({ title: "Anything" }) },
  );
  expect(route(request, new URL(request.url), server)).toBeUndefined();
});

function fork(sessionId: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost/api/sessions/claude/${sessionId}/fork`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return Promise.resolve(route(request, new URL(request.url), server) as Promise<Response>);
}

test("forking answers with the session it started and the pane to watch it in", async () => {
  // 201, because the response names something that did not exist before the request.
  state.watcherState = "live";
  await sessionTranscript();

  const response = await fork(SESSION_ID, { title: "A sibling", prompt: "the other half" });

  expect(response.status).toBe(201);
  const started = await response.json() as { sessionId: string; title: string; tmuxSession: string };
  expect(started.title).toBe("A sibling");
  expect(started.tmuxSession).toBe(`fork-pane-${started.sessionId}`);
  expect(started.sessionId).not.toBe(SESSION_ID);
  expect(forked).toEqual([{
    cwd: expect.any(String),
    sessionId: SESSION_ID,
    forkId: started.sessionId,
    title: "A sibling",
    brief: "the other half",
  }]);
});

test("a fork is named by the session in the path, not by anything in the body", async () => {
  // The whole point of moving this off the Bot endpoint: the source is the thing being addressed.
  state.watcherState = "live";
  await sessionTranscript();

  await fork(SESSION_ID, { title: "Mine", sessionId: "44444444-4444-4444-8444-444444444444" });

  expect(forked[0]?.sessionId).toBe(SESSION_ID);
});

test("refuses a title that cannot be one argument of one command", async () => {
  state.watcherState = "live";
  await sessionTranscript();

  expect((await fork(SESSION_ID, { title: "   " })).status).toBe(400);
  expect((await fork(SESSION_ID, { title: "one\ntwo" })).status).toBe(400);
  expect((await fork(SESSION_ID, { title: 7 })).status).toBe(400);
  expect((await fork(SESSION_ID, {})).status).toBe(400);
  // Refused before anything was started.
  expect(forked).toEqual([]);
});

test("answers 404 for a session the catalog does not hold", async () => {
  state.watcherState = "live";
  const response = await fork("44444444-4444-4444-8444-444444444444", { title: "Nowhere" });
  expect(response.status).toBe(404);
  expect(forked).toEqual([]);
});

test("answers 502 when the CLI could not be started, naming what failed", async () => {
  // Not a 500: the request was valid and what failed is the thing this sidecar delegates to.
  state.watcherState = "live";
  await sessionTranscript();
  forkFailure = new Error("tmux said no");

  const response = await fork(SESSION_ID, { title: "Doomed" });

  expect(response.status).toBe(502);
  expect(await errorMessage(response)).toMatch(/tmux said no/);
});

test("waits for the catalog rather than reporting a session it has not read yet", async () => {
  // 503 and not 404: the fork resolves its source through the catalog, so a catalog that is still
  // starting would otherwise say "no such session" about one that is plainly there.
  state.watcherState = "idle";
  await sessionTranscript();

  const response = await fork(SESSION_ID, { title: "Too early" });

  expect(response.status).toBe(503);
  expect(forked).toEqual([]);
});

test("declines a Codex fork rather than resuming the transcript it cannot branch", async () => {
  state.watcherState = "live";
  const request = new Request(
    `http://localhost/api/sessions/codex/${SESSION_ID}/fork`,
    { method: "POST", body: JSON.stringify({ title: "Anything" }) },
  );
  expect(route(request, new URL(request.url), server)).toBeUndefined();
});

test("forking from a message asks the driver to walk back to it", async () => {
  state.watcherState = "live";
  await sessionTranscript();

  const response = await fork(SESSION_ID, {
    title: "From ALPHA",
    from: { eventId: `claude:${SESSION_ID}:at:0` },
  });

  expect(response.status).toBe(201);
  const started = await response.json() as { sessionId: string; rewindFailed?: string };
  expect(started.rewindFailed).toBeUndefined();
  // One back from the end is BRAVO, so ALPHA is two, and the text travels with the count because
  // the count alone is not evidence the picker landed anywhere in particular.
  expect(rewound).toEqual([{ sessionId: started.sessionId, fromEnd: 2, text: "ALPHA one" }]);
  // The brief is withheld from the command line when there is a rewind coming.
  expect(forked[0]?.brief).toBeUndefined();
});

test("answers 201 with a reason when the fork started but could not be moved", async () => {
  // Not an error status: the session exists, and a caller told only "failed" would not know there
  // was now one running that holds more than it asked for.
  state.watcherState = "live";
  await sessionTranscript();
  rewindOutcome = { done: false, reason: "rewind refused: wrong-message" };

  const response = await fork(SESSION_ID, {
    title: "Adrift",
    from: { eventId: `claude:${SESSION_ID}:at:0` },
  });

  expect(response.status).toBe(201);
  const started = await response.json() as { sessionId: string; rewindFailed?: string };
  expect(started.sessionId).toBeTruthy();
  expect(started.rewindFailed).toMatch(/wrong-message/);
});

test("refuses a row that is not something a person said, before starting anything", async () => {
  state.watcherState = "live";
  await sessionTranscript();

  const response = await fork(SESSION_ID, {
    title: "No",
    // Nine bytes into ALPHA's line, which is no row at all.
    from: { eventId: `claude:${SESSION_ID}:at:9` },
  });

  expect(response.status).toBe(400);
  expect(forked).toEqual([]);
  expect(rewound).toEqual([]);
});

function lastMessage(source: string, sessionId: string): Promise<Response> {
  const request = new Request(`http://localhost/api/sessions/${source}/${sessionId}/last-message`);
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
    text: "ALPHA one",
  });
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
