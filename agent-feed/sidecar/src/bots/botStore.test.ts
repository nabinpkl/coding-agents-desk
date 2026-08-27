import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
