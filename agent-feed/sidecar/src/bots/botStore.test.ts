import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { BotStore } from "@/bots/botStore";
import type { TreeWatch } from "@/transcripts/catalog/watchTree";
import { until } from "@/testing/until";

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
    version: 3,
    revision: 1,
    bots: [],
    idempotency: {},
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await new BotStore(path).snapshot()).toEqual(await store.snapshot());
});

test("serializes concurrent mutations against the latest revision", async () => {
  const { store } = await fixture();
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      store.mutate((snapshot) => ({
        snapshot: { ...snapshot, revision: snapshot.revision + 1 },
        value: index,
      })),
    ),
  );
  expect((await store.snapshot()).revision).toBe(8);
});

test("serializes mutations from independent sidecar stores through bots.json", async () => {
  const { path, store } = await fixture();
  const secondStore = new BotStore(path);
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      (index % 2 === 0 ? store : secondStore).mutate((snapshot) => ({
        snapshot: { ...snapshot, revision: snapshot.revision + 1 },
        value: index,
      })),
    ),
  );

  expect((await store.snapshot()).revision).toBe(8);
  expect((await secondStore.snapshot()).revision).toBe(8);
});

test("rejects malformed existing bots.json instead of treating it as an empty registry", async () => {
  const { path } = await fixture();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "not json", "utf8");

  await expect(new BotStore(path).snapshot()).rejects.toThrow("is not valid JSON");
});

test("migrates a version 2 file by dealing slots in the order its sessions wear", async () => {
  // The only migration slots ever need: a record that predates them reads as its current order,
  // so the stored shape changes and nothing the reader sees does.
  const { path } = await fixture();
  await mkdir(dirname(path), { recursive: true });
  const ref = (sessionId: string) => ({ source: "claude", sessionId });
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      revision: 1,
      bots: [
        {
          botId: "bot-1",
          name: "Captain",
          environment: { kind: "directory", path: "/repo" },
          sessionRefs: [ref("b"), ref("a")],
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
        },
      ],
      idempotency: {},
    }),
    "utf8",
  );

  const snapshot = await new BotStore(path).snapshot();
  expect(snapshot.version).toBe(3);
  expect(snapshot.bots[0]!.sessionSlots).toEqual({ "claude:b": 0, "claude:a": 1 });
  expect(snapshot.bots[0]!.nextSessionSlot).toBe(2);
});

test("rejects structurally invalid Bot records before the registry can consume them", async () => {
  const { path } = await fixture();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      revision: 1,
      bots: [{ botId: "bot-1", name: "Incomplete" }],
      idempotency: {},
    }),
    "utf8",
  );

  await expect(new BotStore(path).snapshot()).rejects.toThrow("contains an invalid Bot record");
});

test("keeps a Bot's Father declaration, and rejects one that names no session or a second Father", async () => {
  // The Father is a reference like any other: well-formed rides along, malformed fails the whole
  // record before the registry can consume it.
  const { path } = await fixture();
  await mkdir(dirname(path), { recursive: true });
  const record = {
    botId: "bot-1",
    name: "Captain",
    environment: { kind: "directory", path: "/repo" },
    sessionRefs: [{ source: "opencode", sessionId: "s1" }],
    metadata: { labels: [], custom: {} },
    grants: [],
    createdAt: 1,
    createdBy: { kind: "user" },
    fatherSession: { source: "opencode", sessionId: "s1" },
  };
  await writeFile(path, JSON.stringify({ version: 3, revision: 1, bots: [record], idempotency: {} }), "utf8");
  expect((await new BotStore(path).snapshot()).bots[0]!.fatherSession).toEqual({
    source: "opencode",
    sessionId: "s1",
  });

  await writeFile(
    path,
    JSON.stringify({
      version: 3,
      revision: 2,
      bots: [{ ...record, fatherSession: { source: "opencode" } }],
      idempotency: {},
    }),
    "utf8",
  );
  await expect(new BotStore(path).snapshot()).rejects.toThrow("contains an invalid Bot record");

  await writeFile(
    path,
    JSON.stringify({
      version: 3,
      revision: 3,
      bots: [record, { ...record, botId: "bot-2", environment: { kind: "directory", path: "/other" } }],
      idempotency: {},
    }),
    "utf8",
  );
  await expect(new BotStore(path).snapshot()).rejects.toThrow("names more than one Father");
});

/**
 * Every re-read the store's watch makes after a change on disk, so a test can tell the watch heard
 * a write rather than waiting a while and assuming it had.
 */
function watchedReads(store: BotStore): Promise<void>[] {
  const inside = store as unknown as { announceExternalChange(): Promise<void> };
  const announce = inside.announceExternalChange.bind(store);
  const reads: Promise<void>[] = [];
  spyOn(inside, "announceExternalChange").mockImplementation(() => {
    const read = announce();
    reads.push(read);
    return read;
  });
  return reads;
}

/**
 * Writes a probe file beside the store until its watch reports it. A new macOS watch misses what is
 * written in its first moments, so this is how a test's own write lands on a watch that is already
 * on. Beside the store's file rather than on it, so the probe is never mistaken for the test's write.
 */
async function watchIsOn(store: BotStore, path: string): Promise<void> {
  const probe = join(dirname(path), "watch-probe");
  const inside = store as unknown as { heard(changed: string): void };
  const heard = inside.heard.bind(store);
  let reported = false;
  const spy = spyOn(inside, "heard").mockImplementation((changed) => {
    if (changed === probe) reported = true;
    heard(changed);
  });
  let wroteAt = 0;
  try {
    await until(async () => {
      // Not on every poll: the watch reports a path once it has gone quiet for a moment, so writes
      // closer together than that would put the report off for as long as they kept coming.
      if (Date.now() - wroteAt > 100) {
        await writeFile(probe, "x");
        wroteAt = Date.now();
      }
      return reported;
    }, "the store's watch to report a write");
  } finally {
    spy.mockRestore();
  }
}

test("announces a write made by another process, without anyone polling for it", async () => {
  // Bots are edited from more than one place: a second sidecar, an editor, a script. Those writes
  // used to reach the panel only because the registry rebuilt a full snapshot every second per
  // subscriber; the file itself is the signal, and asking it 86,400 times a day was the cost of
  // not listening to it.
  const { path, store } = await fixture();
  await store.mutate((snapshot) => ({ snapshot: { ...snapshot, revision: 1 }, value: undefined }));

  const seen: number[] = [];
  const unsubscribe = store.subscribe((snapshot) => seen.push(snapshot.revision));
  await watchIsOn(store, path);

  // Somebody else's atomic write: temp file plus rename, which is what the real `write` does and
  // why the watch is on the directory rather than on this path's inode.
  const temporary = `${path}.other`;
  await writeFile(temporary, `${JSON.stringify({ version: 2, revision: 9, bots: [], idempotency: {} })}\n`);
  await rename(temporary, path);
  await until(() => seen.length > 0, "the other process's write to be announced");
  expect(seen).toEqual([9]);
  unsubscribe();
});

test("does not re-announce a write this process just made", async () => {
  // `mutate` already told the listeners, and its own rename is what wakes the watch. Reporting it
  // twice would make every local edit look like a remote one.
  const { path, store } = await fixture();
  // Made now rather than by the first write, so the watch has a directory to report the probe in.
  await mkdir(dirname(path), { recursive: true });
  const seen: number[] = [];
  const reads = watchedReads(store);
  const unsubscribe = store.subscribe((snapshot) => seen.push(snapshot.revision));
  await watchIsOn(store, path);

  await store.mutate((snapshot) => ({ snapshot: { ...snapshot, revision: 4 }, value: undefined }));
  // The watch hears the rename `mutate` made, and its re-read is what must stay quiet.
  await until(() => reads.length > 0, "the watch to hear this process's own write");
  await Promise.all(reads);

  expect(seen).toEqual([4]);
  unsubscribe();
});

test("keeps its watch when the last listener leaves, because closing one can wedge the process", async () => {
  // Measured 2026-10-19: a Bun watch `close()` parked the main thread on a lock the File Watcher
  // thread was parked on too, and the process never ran again. A panel tab closing and reopening is
  // a last listener leaving and a first arriving.
  const { store } = await fixture();
  const held = store as unknown as { watcher: TreeWatch | null };
  const unsubscribe = store.subscribe(() => {});
  const watcher = held.watcher!;
  const closed = spyOn(watcher, "close");

  unsubscribe();
  const again = store.subscribe(() => {});

  expect(held.watcher).toBe(watcher);
  expect(closed).not.toHaveBeenCalled();
  again();
});
