import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installSessionArchive, SessionArchiveStore } from "@/transcripts/session-ops/sessionArchive";
import { mostRecentSessions, projectSummaries, summarizeSession } from "@/transcripts/catalog/catalogViews";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function archivePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentdesk-session-archive-"));
  directories.push(directory);
  return join(directory, "nested", "session-archive.json");
}

const REF = { source: "claude" as const, sessionId: "0f2a3b4c-0000-4000-8000-000000000001" };

test("archives into a private versioned file that a second store reads back", async () => {
  const path = await archivePath();
  const store = new SessionArchiveStore(path);
  await store.ready();
  expect(store.archivedAt(REF.source, REF.sessionId)).toBeUndefined();

  expect(await store.archive(REF, 1_234)).toBe(1_234);
  expect(store.archivedAt(REF.source, REF.sessionId)).toBe(1_234);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    version: 2,
    sessions: [{ ...REF, archivedAt: 1_234 }],
    projects: [],
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);

  const reread = new SessionArchiveStore(path);
  await reread.ready();
  expect(reread.archivedAt("claude", REF.sessionId.toUpperCase())).toBe(1_234);
});

test("keeps the first timestamp when archived twice, and unarchive reports whether it was", async () => {
  const store = new SessionArchiveStore(await archivePath());
  await store.archive(REF, 1);
  expect(await store.archive(REF, 2)).toBe(1);
  expect(await store.unarchive(REF)).toBe(true);
  expect(store.archivedAt(REF.source, REF.sessionId)).toBeUndefined();
  expect(await store.unarchive(REF)).toBe(false);
});

test("keeps an entry another sidecar wrote since this one loaded", async () => {
  const path = await archivePath();
  const first = new SessionArchiveStore(path);
  const second = new SessionArchiveStore(path);
  await Promise.all([first.ready(), second.ready()]);
  await first.archive(REF, 1);
  await second.archive({ source: "codex", sessionId: "rollout-2" }, 2);
  expect(second.archivedAt(REF.source, REF.sessionId)).toBe(1);
  expect(JSON.parse(await readFile(path, "utf8")).sessions).toHaveLength(2);
});

test("refuses a malformed file rather than treating it as an empty archive", async () => {
  const path = await archivePath();
  const store = new SessionArchiveStore(path);
  await store.ready();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 2, sessions: [{ source: "claude" }], projects: [] }));
  await expect(store.archive(REF)).rejects.toThrow("invalid entry");
  await expect(new SessionArchiveStore(path).ready()).rejects.toThrow("invalid entry");
});

test("the installed archive is what a summarized row carries", async () => {
  const store = new SessionArchiveStore(await archivePath());
  await store.archive(REF, 77);
  installSessionArchive(store);
  try {
    const session = { ...REF, project: "/repo", lastEventAt: 0 };
    expect(summarizeSession(session).archivedAt).toBe(77);
    expect("archivedAt" in summarizeSession({ ...session, sessionId: "other" })).toBe(false);
  } finally {
    installSessionArchive(null);
  }
});

test("refuses a version 1 file rather than reading it without its projects", async () => {
  const path = await archivePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, sessions: [] }));
  await expect(new SessionArchiveStore(path).ready()).rejects.toThrow("version 2");
});

test("archives many sessions in one write and counts only the new ones", async () => {
  const path = await archivePath();
  const store = new SessionArchiveStore(path);
  await store.archive(REF, 1);
  const other = { source: "codex" as const, sessionId: "rollout-2" };
  expect(await store.archiveMany([REF, other, other], 5)).toBe(1);
  expect(store.archivedAt(REF.source, REF.sessionId)).toBe(1);
  expect(store.archivedAt(other.source, other.sessionId)).toBe(5);
  expect(JSON.parse(await readFile(path, "utf8")).sessions).toHaveLength(2);
  expect(await store.archiveMany([REF, other])).toBe(0);
});

test("archives a project folder, moves its time forward when archived again, and unarchives it", async () => {
  const path = await archivePath();
  const store = new SessionArchiveStore(path);
  expect(await store.archiveProject("/repo", 3)).toBe(3);
  expect(await store.archiveProject("/repo", 4)).toBe(4);
  expect(JSON.parse(await readFile(path, "utf8")).projects).toEqual([{ projectPath: "/repo", archivedAt: 4 }]);
  const reread = new SessionArchiveStore(path);
  await reread.ready();
  expect(reread.projectArchivedAt("/repo")).toBe(4);
  expect(await store.unarchiveProject("/repo")).toBe(true);
  expect(store.projectArchivedAt("/repo")).toBeUndefined();
  expect(await store.unarchiveProject("/repo")).toBe(false);
});

test("an archived folder archives every session in it and marks the project, without touching their own entries", async () => {
  const store = new SessionArchiveStore(await archivePath());
  await store.archive(REF, 10);
  await store.archiveProject("/repo", 20);
  installSessionArchive(store);
  try {
    const own = { ...REF, project: "/repo", lastEventAt: 2 };
    const later = { source: "claude" as const, sessionId: "quiet", project: "/repo", lastEventAt: 3 };
    const elsewhere = { source: "claude" as const, sessionId: "elsewhere", project: "/other", lastEventAt: 1 };
    expect(summarizeSession(own).archivedAt).toBe(10);
    expect(summarizeSession(later).archivedAt).toBe(20);
    expect("archivedAt" in summarizeSession(elsewhere)).toBe(false);
    expect(mostRecentSessions([later, own, elsewhere], 10).sessions).toEqual([elsewhere]);
    const projects = projectSummaries([later, own, elsewhere]);
    expect(projects.find((project) => project.projectPath === "/repo")?.archivedAt).toBe(20);
    expect("archivedAt" in projects.find((project) => project.projectPath === "/other")!).toBe(false);

    await store.unarchiveProject("/repo");
    expect(summarizeSession(own).archivedAt).toBe(10);
    expect("archivedAt" in summarizeSession(later)).toBe(false);
  } finally {
    installSessionArchive(null);
  }
});

test("a session written to since its folder was archived shows again, with its folder listed, until the folder is archived again", async () => {
  const store = new SessionArchiveStore(await archivePath());
  await store.archive(REF, 10);
  await store.archiveProject("/repo", 20);
  installSessionArchive(store);
  try {
    const quiet = { source: "claude" as const, sessionId: "quiet", project: "/repo", lastEventAt: 20 };
    const resumed = { source: "claude" as const, sessionId: "resumed", project: "/repo", lastEventAt: 25 };
    // Its own entry still wins: a session archived on its own stays archived over new writes.
    const ownLater = { ...REF, project: "/repo", lastEventAt: 30 };
    expect(summarizeSession(quiet).archivedAt).toBe(20);
    expect("archivedAt" in summarizeSession(resumed)).toBe(false);
    expect(summarizeSession(ownLater).archivedAt).toBe(10);
    expect(mostRecentSessions([ownLater, resumed, quiet], 10).sessions).toEqual([resumed]);
    expect("archivedAt" in projectSummaries([ownLater, resumed, quiet])[0]!).toBe(false);
    // Only a session the reader has archived on its own does not bring the folder back.
    expect(projectSummaries([ownLater, quiet])[0]!.archivedAt).toBe(20);

    await store.archiveProject("/repo", 40);
    expect(summarizeSession(resumed).archivedAt).toBe(40);
    expect(projectSummaries([ownLater, resumed, quiet])[0]!.archivedAt).toBe(40);
  } finally {
    installSessionArchive(null);
  }
});
