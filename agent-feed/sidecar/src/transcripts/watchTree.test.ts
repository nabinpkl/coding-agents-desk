// A tree watch is a replacement for one watch per file, so what is worth pinning is the part
// that had to be rebuilt to make that trade: `fs.watch` reports a relative name and an event kind
// that does not map to add/change/unlink, and everything below is about turning that back into
// what the catalog reads.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchTree, watchTreeEntries, type EntryChange, type TreeWatch } from "./watchTree.ts";

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

/** Waits for a condition the watcher has to deliver, rather than for a fixed delay. */
async function until(predicate: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("reports a path written anywhere under the root", async () => {
  const base = await root();
  await mkdir(join(base, "project"), { recursive: true });
  const seen: string[] = [];
  track(watchTree({ root: base, depth: 1, onPath: (path) => seen.push(path), onError: () => {} }));

  const target = join(base, "project", "session.jsonl");
  await writeFile(target, "one\n");
  await until(() => seen.includes(target));

  expect(seen).toContain(target);
});

test("coalesces one change reported more than once", async () => {
  // `fs.watch` commonly reports a single write as both a rename and a change. Every caller here
  // reacts by reading the file or reconciling a catalog, so the duplicate is real work.
  const base = await root();
  const seen: string[] = [];
  track(watchTree({ root: base, depth: 1, onPath: (path) => seen.push(path), onError: () => {} }));

  const target = join(base, "session.jsonl");
  await writeFile(target, "one\n");
  await writeFile(target, "two\n");
  await writeFile(target, "three\n");
  await until(() => seen.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 120));

  expect(seen.length).toBeGreaterThan(0);
  expect(seen.length).toBeLessThan(3);
});

test("ignores anything deeper than the depth it was given", async () => {
  // The corpora are shaped: a Claude transcript is one directory below its root, and a path
  // deeper than that is somebody else's file that happens to live in the tree.
  const base = await root();
  await mkdir(join(base, "one", "two"), { recursive: true });
  const seen: string[] = [];
  track(watchTree({ root: base, depth: 1, onPath: (path) => seen.push(path), onError: () => {} }));

  const tooDeep = join(base, "one", "two", "buried.jsonl");
  const shallow = join(base, "one", "visible.jsonl");
  await writeFile(tooDeep, "x\n");
  await writeFile(shallow, "x\n");
  await until(() => seen.includes(shallow));

  expect(seen).toContain(shallow);
  expect(seen).not.toContain(tooDeep);
});

test("tells appearing, being written, and vanishing apart", async () => {
  // The distinction chokidar gave for the price of a descriptor per file. Here it costs one
  // stat and a set of strings, which is what makes a thousand-file corpus affordable.
  const base = await root();
  const changes: Array<[string, EntryChange]> = [];
  track(watchTreeEntries({
    root: base,
    depth: 1,
    onEntry: (path, change) => changes.push([path, change]),
    onError: () => {},
  }));

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
});

test("skips a path the caller does not accept, without asking the filesystem", async () => {
  const base = await root();
  const changes: string[] = [];
  track(watchTreeEntries({
    root: base,
    depth: 1,
    accepts: (path) => path.endsWith(".jsonl"),
    onEntry: (path) => changes.push(path),
    onError: () => {},
  }));

  await writeFile(join(base, "notes.txt"), "x\n");
  const wanted = join(base, "kept.jsonl");
  await writeFile(wanted, "x\n");
  await until(() => changes.includes(wanted));

  expect(changes).toEqual([wanted]);
});

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
});
