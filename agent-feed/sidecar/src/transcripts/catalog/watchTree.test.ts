// A tree watch is a replacement for one watch per file, so what is worth pinning is the part
// that had to be rebuilt to make that trade: `fs.watch` reports a relative name and an event kind
// that does not map to add/change/unlink, and everything below is about turning that back into
// what the catalog reads.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchTree, watchTreeEntries, type EntryChange, type TreeWatch } from "@/transcripts/catalog/watchTree";

const roots: string[] = [];
const watches: TreeWatch[] = [];

afterEach(async () => {
  await Promise.all(watches.splice(0).map((watch) => watch.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "watchtree-"));
  roots.push(path);
  return path;
}

function track<T extends TreeWatch>(watch: T): T {
  watches.push(watch);
  return watch;
}

/** Above bun's 5s default per test, which would otherwise cut the budgets below short. */
const PATIENT = 30_000;

/**
 * Waits for a condition the watcher has to deliver, rather than for a fixed delay.
 *
 * The budget is a ceiling, not a delay: a satisfied predicate returns on the next poll, so a
 * longer one costs nothing when the watcher is working.
 */
async function until(predicate: () => boolean, budgetMs = 20_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A throwaway file written until the watch reports it, so the test's own writes land on a watch
 * that is already on.
 *
 * `watch()` returns before macOS has started delivering for the new root, and a write in that gap
 * is never reported -- not late, lost. On a quiet machine the gap is too short to hit; with other
 * processes busy on the disk it is up to ~100ms. Measured 2026-10-18 under six processes churning
 * files: a write 0ms after `watch()` was lost 3 times in 4, one 100ms or more after it was seen
 * 16 times in 16, and a watch that lost its first writes reported a write three seconds later
 * within 4ms. That is why these tests used to pass alone and fail inside the full suite, waiting
 * twenty seconds for an event that had already been dropped.
 */
function arming(base: string) {
  const path = join(base, "arming.jsonl");
  let heard = false;
  return {
    /** True for the arming file's own reports, which the test leaves out of what it asserts on. */
    claims(reported: string): boolean {
      if (reported !== path) return false;
      heard = true;
      return true;
    },
    async ready(): Promise<void> {
      const deadline = Date.now() + 5_000;
      while (!heard && Date.now() < deadline) {
        await writeFile(path, `${Date.now()}\n`);
        await until(() => heard, 250);
      }
      if (!heard) throw new Error("the watch never reported its arming file within 5s");
    },
  };
}

test("reports a path written anywhere under the root", async () => {
  const base = await root();
  await mkdir(join(base, "project"), { recursive: true });
  const seen: string[] = [];
  const arm = arming(base);
  track(watchTree({ root: base, depth: 1, onPath: (path) => arm.claims(path) || seen.push(path), onError: () => {} }));
  await arm.ready();

  const target = join(base, "project", "session.jsonl");
  await writeFile(target, "one\n");
  await until(() => seen.includes(target));

  expect(seen).toContain(target);
}, PATIENT);

test("coalesces one change reported more than once", async () => {
  // `fs.watch` commonly reports a single write as both a rename and a change. Every caller here
  // reacts by reading the file or reconciling a catalog, so the duplicate is real work.
  const base = await root();
  const seen: string[] = [];
  const arm = arming(base);
  track(watchTree({ root: base, depth: 1, onPath: (path) => arm.claims(path) || seen.push(path), onError: () => {} }));
  await arm.ready();

  const target = join(base, "session.jsonl");
  await writeFile(target, "one\n");
  await writeFile(target, "two\n");
  await writeFile(target, "three\n");
  await until(() => seen.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 120));

  expect(seen.length).toBeGreaterThan(0);
  expect(seen.length).toBeLessThan(3);
}, PATIENT);

test("ignores anything deeper than the depth it was given", async () => {
  // The corpora are shaped: a Claude transcript is one directory below its root, and a path
  // deeper than that is somebody else's file that happens to live in the tree.
  const base = await root();
  await mkdir(join(base, "one", "two"), { recursive: true });
  const seen: string[] = [];
  const arm = arming(base);
  track(watchTree({ root: base, depth: 1, onPath: (path) => arm.claims(path) || seen.push(path), onError: () => {} }));
  await arm.ready();

  const tooDeep = join(base, "one", "two", "buried.jsonl");
  const shallow = join(base, "one", "visible.jsonl");
  await writeFile(tooDeep, "x\n");
  await writeFile(shallow, "x\n");
  await until(() => seen.includes(shallow));

  expect(seen).toContain(shallow);
  expect(seen).not.toContain(tooDeep);
}, PATIENT);

test("tells appearing, being written, and vanishing apart", async () => {
  // The distinction chokidar gave for the price of a descriptor per file. Here it costs one
  // stat and a set of strings, which is what makes a thousand-file corpus affordable.
  const base = await root();
  const changes: Array<[string, EntryChange]> = [];
  const arm = arming(base);
  track(watchTreeEntries({
    root: base,
    depth: 1,
    onEntry: (path, change) => arm.claims(path) || changes.push([path, change]),
    onError: () => {},
  }));
  await arm.ready();

  const target = join(base, "rollout.jsonl");
  await writeFile(target, "one\n");
  await until(() => changes.length >= 1);
  await writeFile(target, "one\ntwo\n");
  await until(() => changes.length >= 2);
  await unlink(target);
  await until(() => changes.some(([, change]) => change === "vanished"));

  expect(changes[0]).toEqual([target, "appeared"]);
  expect(changes.some(([, change]) => change === "written")).toBe(true);
  expect(changes.at(-1)).toEqual([target, "vanished"]);
}, PATIENT);

test("skips a path the caller does not accept, without asking the filesystem", async () => {
  const base = await root();
  const changes: string[] = [];
  const arm = arming(base);
  track(watchTreeEntries({
    root: base,
    depth: 1,
    accepts: (path) => path.endsWith(".jsonl"),
    onEntry: (path) => arm.claims(path) || changes.push(path),
    onError: () => {},
  }));
  await arm.ready();

  await writeFile(join(base, "notes.txt"), "x\n");
  const wanted = join(base, "kept.jsonl");
  await writeFile(wanted, "x\n");
  await until(() => changes.includes(wanted));

  expect(changes).toEqual([wanted]);
}, PATIENT);

test("waits for a root that does not exist yet instead of throwing", async () => {
  // The pi sessions directory legitimately does not exist until pi has run once. chokidar waited
  // for it; a bare `fs.watch` would have thrown at startup and taken the catalog with it.
  const base = await root();
  const missing = join(base, "not-here-yet");
  const errors: unknown[] = [];
  const watch = track(watchTree({
    root: missing,
    depth: 1,
    onPath: () => {},
    onError: (error) => errors.push(error),
  }));

  expect(errors).toEqual([]);
  await watch.close();
}, PATIENT);
