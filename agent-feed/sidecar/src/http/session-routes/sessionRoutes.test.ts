import { afterEach, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionRoutes } from "@/http/session-routes/sessionRoutes";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

const server = { timeout() {} } as never;
const route = createSessionRoutes();
const roots: string[] = [];
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

/**
 * The rename asks the session's own CLI to run `/rename`, so what a test can observe is what was
 * asked of tmux -- there is deliberately no file write to look for.
 */
const renamed: { sessionId: string; title: string }[] = [];
let outcome: { renamed: true } | { renamed: false; reason: string } = { renamed: true };
mock.module("@/input/tmuxComposer.ts", () => ({
  renameTmuxSession: async (sessionId: string, title: string) => {
    renamed.push({ sessionId, title });
    return outcome;
  },
}));

afterEach(async () => {
  state.sessions.clear();
  state.watcherState = "idle";
  renamed.length = 0;
  outcome = { renamed: true };
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A transcript the catalog knows about, which is all the rename needs from it. */
async function sessionTranscript(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-rename-"));
  roots.push(root);
  const transcript = join(root, `${SESSION_ID}.jsonl`);
  await writeFile(transcript, `${JSON.stringify({ type: "user", cwd: root })}\n`);
  state.sessions.set(sessionKey("claude", SESSION_ID), {
    source: "claude",
    sessionId: SESSION_ID,
    project: root,
    transcriptPath: transcript,
    lastEventAt: 1_000,
  });
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
