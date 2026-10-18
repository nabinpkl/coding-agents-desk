import { expect, test } from "bun:test";
import type { BotSessionRef } from "@agentdesk/agent-feed-wire";
import { createProjectArchiveRoutes } from "@/http/agent-routes/projectArchiveRoutes";
import type { Session } from "@/transcripts/transcriptTypes";

const STOPPED: Session = { sessionId: "stopped", source: "claude", project: "/repo", lastEventAt: 0 };
const RUNNING: Session = { sessionId: "running", source: "opencode", project: "/repo", lastEventAt: 0 };

function harness(options: { sessions?: Session[]; running?: string[]; ready?: boolean; failCheck?: boolean } = {}) {
  const archivedMany: BotSessionRef[][] = [];
  const archivedProjects: string[] = [];
  const unarchivedProjects: string[] = [];
  let announced = 0;
  const route = createProjectArchiveRoutes({
    archive: {
      archiveMany: async (refs) => {
        archivedMany.push([...refs]);
        return refs.length;
      },
      archiveProject: async (path) => {
        archivedProjects.push(path);
        return 42;
      },
      unarchiveProject: async (path) => {
        unarchivedProjects.push(path);
        return true;
      },
    },
    isRunning: async (session) => {
      if (options.failCheck) throw new Error("ps failed");
      return (options.running ?? []).includes(session.sessionId);
    },
    announce: () => {
      announced += 1;
    },
    sessionsIn: (path) => (options.sessions ?? [STOPPED]).filter((session) => session.project === path),
    catalogReady: () => options.ready ?? true,
  });
  const post = async (action: string, body: unknown): Promise<Response | undefined> => {
    const url = new URL(`http://sidecar/api/projects/${action}`);
    const init: RequestInit = { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) };
    return route(new Request(url.href, init), url, undefined as never);
  };
  return { post, archivedMany, archivedProjects, unarchivedProjects, announced: () => announced };
}

async function errorCode(response: Response | undefined): Promise<string> {
  return ((await response?.json()) as { error: { code: string } }).error.code;
}

test("archives a folder with nothing running and tells the streams", async () => {
  const h = harness();
  const response = await h.post("archive", { projectPath: "/repo" });
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ projectPath: "/repo", archived: true, archivedAt: 42 });
  expect(h.archivedProjects).toEqual(["/repo"]);
  expect(h.announced()).toBe(1);
});

test("refuses a folder with a running session and archives nothing", async () => {
  const h = harness({ sessions: [STOPPED, RUNNING], running: ["running"] });
  const response = await h.post("archive", { projectPath: "/repo" });
  expect(response?.status).toBe(409);
  expect(await errorCode(response)).toBe("session-running");
  expect(h.archivedProjects).toEqual([]);
  expect(h.announced()).toBe(0);
});

test("archives every stopped session in one call and says how many were left running", async () => {
  const h = harness({ sessions: [STOPPED, RUNNING], running: ["running"] });
  const response = await h.post("archive-sessions", { projectPath: "/repo" });
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ projectPath: "/repo", archived: 1, running: 1 });
  expect(h.archivedMany).toEqual([[{ source: "claude", sessionId: "stopped" }]]);
  expect(h.archivedProjects).toEqual([]);
  expect(h.announced()).toBe(1);
});

test("archiving the sessions of a folder where every one is running writes nothing", async () => {
  const h = harness({ sessions: [RUNNING], running: ["running"] });
  const response = await h.post("archive-sessions", { projectPath: "/repo" });
  expect(await response?.json()).toEqual({ projectPath: "/repo", archived: 0, running: 1 });
  expect(h.archivedMany).toEqual([]);
  expect(h.announced()).toBe(0);
});

test("unarchives a folder without asking the catalog", async () => {
  const h = harness({ ready: false });
  const response = await h.post("unarchive", { projectPath: "/repo" });
  expect(await response?.json()).toEqual({ projectPath: "/repo", archived: false });
  expect(h.unarchivedProjects).toEqual(["/repo"]);
  expect(h.announced()).toBe(1);
});

test("answers an unknown folder, a starting catalog, a failed check and a bad body without archiving", async () => {
  expect(await errorCode(await harness().post("archive", { projectPath: "/nowhere" }))).toBe("project-not-found");
  expect(await errorCode(await harness({ ready: false }).post("archive", { projectPath: "/repo" }))).toBe("inventory-not-ready");
  const failing = harness({ failCheck: true });
  const failed = await failing.post("archive-sessions", { projectPath: "/repo" });
  expect(failed?.status).toBe(503);
  expect(failing.archivedMany).toEqual([]);
  expect(await errorCode(await harness().post("archive", "not json"))).toBe("invalid-request");
  expect(await errorCode(await harness().post("archive", { projectPath: "" }))).toBe("invalid-request");
});

test("leaves other paths and methods to other routes", async () => {
  const route = createProjectArchiveRoutes({
    archive: { archiveMany: async () => 0, archiveProject: async () => 0, unarchiveProject: async () => false },
    isRunning: async () => false,
  });
  const url = new URL("http://sidecar/api/projects/archive");
  expect(route(new Request(url.href), url, undefined as never)).toBeUndefined();
  const other = new URL("http://sidecar/api/projects/rename");
  expect(route(new Request(other.href, { method: "POST" }), other, undefined as never)).toBeUndefined();
});
