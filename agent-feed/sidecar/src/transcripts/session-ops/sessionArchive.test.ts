import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installSessionArchive, SessionArchiveStore } from "@/transcripts/session-ops/sessionArchive";
import { summarizeSession } from "@/transcripts/catalog/catalogViews";

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
    version: 1,
    sessions: [{ ...REF, archivedAt: 1_234 }],
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
  await writeFile(path, JSON.stringify({ version: 1, sessions: [{ source: "claude" }] }));
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
