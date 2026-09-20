import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createEventImageRoutes } from "@/http/session-routes/eventImageRoutes";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

const server = { timeout() {} } as never;
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
const route = createEventImageRoutes();
const roots: string[] = [];

afterEach(async () => {
  state.sessions.delete(sessionKey("claude", SESSION_ID));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A transcript the catalog knows, whose only line is a person pasting an image under some text. */
async function transcriptWithPastedImage(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-event-image-"));
  roots.push(root);
  const transcript = join(root, `${SESSION_ID}.jsonl`);
  const line = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: "[Image #1] this one" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
      ],
    },
    timestamp: "2026-09-14T05:00:00.000Z",
    uuid: crypto.randomUUID(),
  });
  await writeFile(transcript, `${line}\n`);
  state.sessions.set(sessionKey("claude", SESSION_ID), {
    source: "claude",
    sessionId: SESSION_ID,
    project: root,
    transcriptPath: transcript,
    lastEventAt: 1_000,
  });
}

function get(path: string): Promise<Response> {
  const request = new Request(`http://localhost${path}`);
  return Promise.resolve(route(request, new URL(request.url), server) as Promise<Response>);
}

test("serves the bytes behind an image block as the image itself", async () => {
  await transcriptWithPastedImage();

  const response = await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/1/image?mode=nice`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(PNG_BASE64);
});

test("refuses a block that is not an image, rather than serving its text as one", async () => {
  await transcriptWithPastedImage();

  const response = await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/0/image?mode=nice`);

  expect(response.status).toBe(404);
});

test("refuses a mode it does not know, because an index means a different line in each", async () => {
  await transcriptWithPastedImage();

  const response = await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/1/image?mode=pretty`);

  expect(response.status).toBe(400);
});

test("leaves every other path to the routes after it", async () => {
  expect(await get(`/api/sessions/claude/${SESSION_ID}/events/0/raw`)).toBeUndefined();
});
