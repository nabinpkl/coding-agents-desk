import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectsPayload, SessionsPayload } from "@agentdesk/agent-feed-wire";
import { createInventoryRoutes } from "@/http/inventoryRoutes";
import { registerPiSession, sessionKey, stopCatalog } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

const server = { timeout() {} } as never;
const route = createInventoryRoutes();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await stopCatalog();
  state.sessions.clear();
  state.watcherState = "idle";
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

type InventoryMessage = ProjectsPayload | SessionsPayload | { error: string };

/**
 * One reader over an open stream, taken in batches.
 *
 * One reader for the whole stream, not one per read: a second `getReader()` on the
 * same body throws, and the point of these tests is that a surface follows the
 * inventory through a single connection.
 *
 * Cancelling is the caller's, not this helper's: the sidecar tears a stream's
 * subscription down the moment its reader is gone, so a helper that cancelled on its
 * own would be asserting against a subscription that had already stopped.
 */
function streamReader(response: Response): {
  take: (count: number) => Promise<InventoryMessage[]>;
  leave: () => Promise<void>;
} {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const pending: InventoryMessage[] = [];
  let buffer = "";
  return {
    async take(count) {
      while (pending.length < count) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith("data: ")) {
            pending.push(JSON.parse(frame.slice(6)) as InventoryMessage);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
      return pending.splice(0, count);
    },
    leave: () => reader.cancel(),
  };
}

/** A project directory holding one Claude session, registered in the catalog. */
async function projectWithSession(name: string, sessionId: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `agent-feed-inventory-${name}-`));
  temporaryDirectories.push(root);
  // Realpathed, because the catalog canonicalizes every project path and the stream
  // ignores a request for one that is not already canonical -- and a temporary
  // directory on macOS is reached through a symlink.
  const project = join(root, "project");
  await mkdir(project);
  const canonical = await realpath(project);
  const transcript = join(root, `${sessionId}.jsonl`);
  await writeFile(
    transcript,
    `${JSON.stringify({
      type: "user",
      cwd: canonical,
      message: { role: "user", content: `${name} prompt` },
    })}\n`,
  );
  state.sessions.set(sessionKey("claude", sessionId), {
    source: "claude",
    sessionId,
    project: canonical,
    transcriptPath: transcript,
    lastEventAt: 1_000,
  });
  return canonical;
}

function open(query: string): Promise<Response> {
  const request = new Request(`http://localhost/api/inventory/stream${query}`);
  return Promise.resolve(route(request, new URL(request.url), server) as Promise<Response>);
}

test("one stream carries the project list and every requested project's sessions", async () => {
  state.watcherState = "live";
  const alpha = await projectWithSession("alpha", "11111111-1111-1111-1111-111111111111");
  const beta = await projectWithSession("beta", "22222222-2222-2222-2222-222222222222");

  const response = await open(
    `?projectPath=${encodeURIComponent(alpha)}&projectPath=${encodeURIComponent(beta)}`,
  );
  const { take, leave } = streamReader(response);
  const messages = await take(3);

  // The project list leads, because the sidebar cannot place a session list without it.
  const projects = messages[0] as ProjectsPayload;
  expect(projects.projects.map((project) => project.projectPath).sort()).toEqual(
    [alpha, beta].sort(),
  );
  // Both session lists arrive on the same connection, each named by its project.
  const sessions = messages.slice(1) as SessionsPayload[];
  expect(sessions.map((message) => message.projectPath).sort()).toEqual([alpha, beta].sort());
  expect(sessions.every((message) => message.sessions.length === 1)).toBeTrue();
  await leave();
});

test("a project the surface did not ask for costs it nothing", async () => {
  state.watcherState = "live";
  const alpha = await projectWithSession("alpha", "11111111-1111-1111-1111-111111111111");
  await projectWithSession("beta", "22222222-2222-2222-2222-222222222222");

  const response = await open(`?projectPath=${encodeURIComponent(alpha)}`);
  const { take, leave } = streamReader(response);
  const messages = await take(2);

  expect((messages[0] as ProjectsPayload).projects).toHaveLength(2);
  expect((messages[1] as SessionsPayload).projectPath).toBe(alpha);
  await leave();
});

test("a catalog change re-sends only what it changed", async () => {
  state.watcherState = "live";
  const alpha = await projectWithSession("alpha", "11111111-1111-1111-1111-111111111111");

  const response = await open(`?projectPath=${encodeURIComponent(alpha)}`);
  const { take, leave } = streamReader(response);
  expect(await take(2)).toHaveLength(2);

  // A session in a project this surface has open: its list is re-sent, and so is the
  // project list, whose session count moved with it.
  registerPiSession({
    sessionId: "33333333-3333-3333-3333-333333333333",
    projectPath: alpha,
    transcriptPath: join(alpha, "pi.jsonl"),
    title: "pi thread",
    lastEventAt: 2_000,
  });
  const followUp = await take(2);
  const sessions = followUp.find((message) => "sessions" in message) as SessionsPayload;
  expect(sessions.sessions).toHaveLength(2);
  expect(followUp.some((message) => "projects" in message)).toBeTrue();
  await leave();
});

test("a project that vanished is dropped from the stream, not fatal to it", async () => {
  state.watcherState = "live";
  const alpha = await projectWithSession("alpha", "11111111-1111-1111-1111-111111111111");

  const response = await open(
    `?projectPath=${encodeURIComponent(alpha)}&projectPath=%2Fno%2Fsuch%2Fproject`,
  );
  const { take, leave } = streamReader(response);
  const messages = await take(2);

  // Refusing would deadlock the reader: the requested set is what it had expanded, and
  // the only thing that would tell it a project is gone is the list on this stream.
  expect(response.status).toBe(200);
  expect((messages[0] as ProjectsPayload).projects).toHaveLength(1);
  expect((messages[1] as SessionsPayload).projectPath).toBe(alpha);
  await leave();
});
