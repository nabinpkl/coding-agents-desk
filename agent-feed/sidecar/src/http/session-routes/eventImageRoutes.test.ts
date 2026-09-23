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

/**
 * A transcript whose only line is a call handing files to the reader, with `files` pointing at
 * whatever paths the test wants named.
 */
async function transcriptSendingFiles(files: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-sent-file-"));
  roots.push(root);
  const transcript = join(root, `${SESSION_ID}.jsonl`);
  const line = JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "call-1",
        name: "SendUserFile",
        input: { files, caption: "Two renders", status: "normal" },
      }],
    },
    timestamp: "2026-09-15T05:00:00.000Z",
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
  return root;
}

test("serves a picture a call handed over, named by its place in that call", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-sent-"));
  roots.push(root);
  const picture = join(root, "render.png");
  await writeFile(picture, Buffer.from(PNG_BASE64, "base64"));
  await transcriptSendingFiles([picture]);

  const response = await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/0/files/0?mode=nice`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(PNG_BASE64);
});

test("serves nothing the transcript did not name, whatever the request asks for", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-sent-"));
  roots.push(root);
  const picture = join(root, "render.png");
  await writeFile(picture, Buffer.from(PNG_BASE64, "base64"));
  await transcriptSendingFiles([picture]);

  // Past the end of the list the call actually made.
  expect((await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/0/files/1?mode=nice`)).status)
    .toBe(404);
  // And a block that hands nothing over.
  expect((await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/1/files/0?mode=nice`)).status)
    .toBe(404);
});

test("refuses a file whose bytes are not the picture its name promises", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-sent-"));
  roots.push(root);
  const secret = join(root, "id_rsa.png");
  await writeFile(secret, "-----BEGIN OPENSSH " + "PRIVATE KEY-----\n");
  await transcriptSendingFiles([secret, join(root, "gone.png"), root]);

  // Named by the transcript, extension and all, and still refused: the bytes are sniffed.
  expect((await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/0/files/0?mode=nice`)).status)
    .toBe(415);
  // A path that is not there, and a directory.
  expect((await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/0/files/1?mode=nice`)).status)
    .toBe(404);
  expect((await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/0/files/2?mode=nice`)).status)
    .toBe(404);
});

test("serves a page a call handed over, in an origin of its own", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-sent-"));
  roots.push(root);
  const page = join(root, "eye variants.html");
  await writeFile(page, "<!doctype html><title>Ten eyes</title>\n");
  await transcriptSendingFiles([page]);

  const response = await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/0/files/0?mode=nice`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  // No `allow-same-origin`, which is the whole point: the panel's origin has no auth in front of
  // it, so a page served AS the panel would be handed the sidecar's whole API.
  expect(response.headers.get("content-security-policy")).toBe(
    "sandbox allow-scripts allow-forms allow-popups",
  );
  // Rendered in the tab, under the name the reader knows it by, spaces and all.
  expect(response.headers.get("content-disposition")).toBe(
    "inline; filename*=UTF-8''eye%20variants.html",
  );
  expect(await response.text()).toContain("Ten eyes");
});

test("serves a text file as text, whatever it is called", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-sent-"));
  roots.push(root);
  const report = join(root, "run.log");
  await writeFile(report, "1432 tests passed\n");
  await transcriptSendingFiles([report]);

  const response = await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/0/files/0?mode=nice`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(response.headers.get("content-security-policy")).toBeNull();
  expect(await response.text()).toBe("1432 tests passed\n");
});

test("hands a file it cannot recognise over as a download rather than rendering a guess", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-sent-"));
  roots.push(root);
  const blob = join(root, "trace.bin");
  await writeFile(blob, Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00]));
  await transcriptSendingFiles([blob]);

  const response = await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/0/files/0?mode=nice`);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("content-disposition")).toBe(
    "attachment; filename*=UTF-8''trace.bin",
  );
});

test("refuses a relative path, which names a directory nobody agreed on", async () => {
  await transcriptSendingFiles(["render.png"]);

  expect((await get(`/api/sessions/claude/${SESSION_ID}/events/0/blocks/0/files/0?mode=nice`)).status)
    .toBe(404);
});
