import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { BotStore } from "./botStore.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ path: string; store: BotStore }> {
  const directory = await mkdtemp(join(tmpdir(), "agentdesk-bots-store-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "nested", "bots.json");
  return { path, store: new BotStore(path) };
}

test("persists a revisioned snapshot atomically with private permissions", async () => {
  const { path, store } = await fixture();
  await store.mutate((snapshot) => ({
    snapshot: { ...snapshot, revision: 1 },
    value: undefined,
  }));

  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    version: 2,
    revision: 1,
    bots: [],
    idempotency: {},
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await new BotStore(path).snapshot()).toEqual(await store.snapshot());
});

test("serializes concurrent mutations against the latest revision", async () => {
  const { store } = await fixture();
  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    store.mutate((snapshot) => ({
      snapshot: { ...snapshot, revision: snapshot.revision + 1 },
      value: index,
    }))
  ));
  expect((await store.snapshot()).revision).toBe(8);
});

test("serializes mutations from independent sidecar stores through bots.json", async () => {
  const { path, store } = await fixture();
  const secondStore = new BotStore(path);
  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 === 0 ? store : secondStore).mutate((snapshot) => ({
      snapshot: { ...snapshot, revision: snapshot.revision + 1 },
      value: index,
    }))
  ));

  expect((await store.snapshot()).revision).toBe(8);
  expect((await secondStore.snapshot()).revision).toBe(8);
});

test("rejects malformed existing bots.json instead of treating it as an empty registry", async () => {
  const { path } = await fixture();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "not json", "utf8");

  await expect(new BotStore(path).snapshot()).rejects.toThrow("is not valid JSON");
});

test("rejects structurally invalid Bot records before the registry can consume them", async () => {
  const { path } = await fixture();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    version: 2,
    revision: 1,
    bots: [{ botId: "bot-1", name: "Incomplete" }],
    idempotency: {},
  }), "utf8");

  await expect(new BotStore(path).snapshot()).rejects.toThrow("contains an invalid Bot record");
});

test("announces a write made by another process, without anyone polling for it", async () => {
  // Bots are edited from more than one place: a second sidecar, an editor, a script. Those writes
  // used to reach the panel only because the registry rebuilt a full snapshot every second per
  // subscriber; the file itself is the signal, and asking it 86,400 times a day was the cost of
  // not listening to it.
  const { path, store } = await fixture();
  await store.mutate((snapshot) => ({ snapshot: { ...snapshot, revision: 1 }, value: undefined }));

  const seen: number[] = [];
  const unsubscribe = store.subscribe((snapshot) => seen.push(snapshot.revision));
  // chokidar needs its initial scan to finish before it reports anything.
  await Bun.sleep(60);

  // Somebody else's atomic write: temp file plus rename, which is what the real `write` does and
  // why the watch is on the directory rather than on this path's inode.
  const temporary = `${path}.other`;
  await writeFile(temporary, `${JSON.stringify({ version: 2, revision: 9, bots: [], idempotency: {} })}\n`);
  await rename(temporary, path);

  await Bun.sleep(250);
  expect(seen).toEqual([9]);
  unsubscribe();
});

test("does not re-announce a write this process just made", async () => {
  // `mutate` already told the listeners, and its own rename is what wakes the watch. Reporting it
  // twice would make every local edit look like a remote one.
  const { store } = await fixture();
  const seen: number[] = [];
  const unsubscribe = store.subscribe((snapshot) => seen.push(snapshot.revision));
  await Bun.sleep(60);

  await store.mutate((snapshot) => ({ snapshot: { ...snapshot, revision: 4 }, value: undefined }));
  await Bun.sleep(250);

  expect(seen).toEqual([4]);
  unsubscribe();
});
