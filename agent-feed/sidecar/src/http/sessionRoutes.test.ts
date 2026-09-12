import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionRoutes } from "./sessionRoutes.ts";
import { sessionKey } from "../transcripts/transcriptCatalog.ts";
import { claudeAdapter } from "../transcripts/sources/claudeTranscript.ts";
import { state } from "../transcripts/transcriptState.ts";

const server = { timeout() {} } as never;
const route = createSessionRoutes();
const roots: string[] = [];
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

afterEach(async () => {
  state.sessions.clear();
  state.watcherState = "idle";
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A transcript the catalog knows about, opened in `cwd` and carrying a generated title. */
async function sessionTranscript(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-rename-"));
  roots.push(root);
  const transcript = join(root, `${SESSION_ID}.jsonl`);
  await writeFile(
    transcript,
    `${JSON.stringify({ type: "user", cwd: root, aiTitle: "What the harness called it" })}\n`,
  );
  state.sessions.set(sessionKey("claude", SESSION_ID), {
    source: "claude",
    sessionId: SESSION_ID,
    project: root,
    transcriptPath: transcript,
    lastEventAt: 1_000,
  });
  return transcript;
}

function rename(sessionId: string, body: unknown): Promise<Response> {
  const request = new Request(`http://localhost/api/sessions/claude/${sessionId}/title`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return Promise.resolve(route(request, new URL(request.url), server) as Promise<Response>);
}

test("renaming a session appends the record the CLI writes", async () => {
  state.watcherState = "live";
  const transcript = await sessionTranscript();

  const response = await rename(SESSION_ID, { title: "  What I called it  " });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ sessionId: SESSION_ID, title: "What I called it" });
  const lines = (await readFile(transcript, "utf-8")).trimEnd().split("\n");
  expect(JSON.parse(lines.at(-1)!)).toEqual({
    type: "custom-title",
    customTitle: "What I called it",
    sessionId: SESSION_ID,
  });
});

test("the appended record is the title the catalog then reads", async () => {
  // The whole mechanism in one assertion: nothing is notified and no API is called, so if the
  // header read did not rank a trailing `custom-title` above the harness's own title, a rename
  // would write a line that changed nothing.
  state.watcherState = "live";
  const transcript = await sessionTranscript();

  await rename(SESSION_ID, { title: "What I called it" });

  expect((await claudeAdapter.readHeader(transcript))?.title).toBe("What I called it");
});

test("refuses a title that cannot be one line of one record", async () => {
  state.watcherState = "live";
  await sessionTranscript();

  expect((await rename(SESSION_ID, { title: "   " })).status).toBe(400);
  expect((await rename(SESSION_ID, { title: "one\ntwo" })).status).toBe(400);
  expect((await rename(SESSION_ID, { title: "x".repeat(241) })).status).toBe(400);
  expect((await rename(SESSION_ID, { title: 7 })).status).toBe(400);
});

test("answers 404 for a session the catalog does not hold", async () => {
  state.watcherState = "live";
  const response = await rename("44444444-4444-4444-8444-444444444444", { title: "Anything" });
  expect(response.status).toBe(404);
});

test("declines a Codex rename rather than answering for a title it does not own", async () => {
  state.watcherState = "live";
  const request = new Request(
    `http://localhost/api/sessions/codex/${SESSION_ID}/title`,
    { method: "POST", body: JSON.stringify({ title: "Anything" }) },
  );
  expect(route(request, new URL(request.url), server)).toBeUndefined();
});

test("appends onto a transcript whose last record has no trailing newline", async () => {
  // A transcript whose writer died mid-record ends without one. Appending straight onto that line
  // would fuse the two into a record that parses as nothing, losing what the CLI had written.
  state.watcherState = "live";
  const transcript = await sessionTranscript();
  await appendFile(transcript, JSON.stringify({ type: "user", message: "half-writ" }));

  await rename(SESSION_ID, { title: "What I called it" });

  const lines = (await readFile(transcript, "utf-8")).trimEnd().split("\n");
  expect(JSON.parse(lines.at(-2)!)).toMatchObject({ message: "half-writ" });
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ customTitle: "What I called it" });
});
