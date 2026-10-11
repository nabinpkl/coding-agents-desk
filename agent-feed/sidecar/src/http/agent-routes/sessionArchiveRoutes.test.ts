import { expect, test } from "bun:test";
import type { BotSessionRef } from "@agentdesk/agent-feed-wire";
import { createSessionArchiveRoutes } from "@/http/agent-routes/sessionArchiveRoutes";
import type { Session } from "@/transcripts/transcriptTypes";

const SESSION: Session = {
  sessionId: "0f2a3b4c-0000-4000-8000-000000000001",
  source: "claude",
  project: "/repo",
  lastEventAt: 0,
};

function harness(options: { running?: boolean; known?: boolean; ready?: boolean } = {}) {
  const archived: BotSessionRef[] = [];
  const unarchived: BotSessionRef[] = [];
  let announced = 0;
  const route = createSessionArchiveRoutes({
    archive: {
      archive: async (ref) => {
        archived.push(ref);
        return 42;
      },
      unarchive: async (ref) => {
        unarchived.push(ref);
        return true;
      },
    },
    isRunning: async () => options.running ?? false,
    announce: () => {
      announced += 1;
    },
    find: (source, sessionId) =>
      options.known === false || source !== SESSION.source || sessionId !== SESSION.sessionId ? undefined : SESSION,
    catalogReady: () => options.ready ?? true,
  });
  const post = async (path: string): Promise<Response | undefined> => {
    const url = new URL(`http://sidecar${path}`);
    return route(new Request(url.href, { method: "POST" }), url, undefined as never);
  };
  return { post, archived, unarchived, announced: () => announced };
}

test("archives a stopped session and tells the streams", async () => {
  const h = harness();
  const response = await h.post(`/api/sessions/claude/${SESSION.sessionId}/archive`);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ source: "claude", sessionId: SESSION.sessionId, archived: true, archivedAt: 42 });
  expect(h.archived).toEqual([{ source: "claude", sessionId: SESSION.sessionId }]);
  expect(h.announced()).toBe(1);
});

test("refuses a running session with 409 and archives nothing", async () => {
  const h = harness({ running: true });
  const response = await h.post(`/api/sessions/claude/${SESSION.sessionId}/archive`);
  expect(response?.status).toBe(409);
  expect(((await response?.json()) as { error: { code: string } }).error.code).toBe("session-running");
  expect(h.archived).toEqual([]);
  expect(h.announced()).toBe(0);
});

test("answers 404 for a session the catalog does not hold, and 503 while it is starting", async () => {
  expect((await harness({ known: false }).post(`/api/sessions/claude/${SESSION.sessionId}/archive`))?.status).toBe(404);
  expect((await harness({ ready: false }).post(`/api/sessions/claude/${SESSION.sessionId}/archive`))?.status).toBe(503);
});

test("unarchives without asking whether the session runs", async () => {
  const h = harness({ running: true, known: false, ready: false });
  const response = await h.post(`/api/sessions/codex/rollout-2/unarchive`);
  expect(response?.status).toBe(200);
  expect(h.unarchived).toEqual([{ source: "codex", sessionId: "rollout-2" }]);
  expect(h.announced()).toBe(1);
});

test("leaves every other path and method to the routes after it", async () => {
  const h = harness();
  expect(await h.post(`/api/sessions/claude/${SESSION.sessionId}/title`)).toBeUndefined();
  const url = new URL(`http://sidecar/api/sessions/claude/${SESSION.sessionId}/archive`);
  const route = createSessionArchiveRoutes({ archive: { archive: async () => 0, unarchive: async () => false }, isRunning: async () => false });
  expect(route(new Request(url.href), url, undefined as never)).toBeUndefined();
});
