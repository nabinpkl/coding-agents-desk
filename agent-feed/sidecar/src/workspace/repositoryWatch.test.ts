import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryEventSource } from "@/workspace/repositoryEvents";
import { RepositoryGitWatch } from "@/workspace/repositoryWatch";
import type { DirectoryGitStatus } from "@/workspace/workspaceGit";
import { until } from "@/testing/until";

const roots: string[] = [];
const watches: RepositoryGitWatch[] = [];

afterEach(async () => {
  await Promise.all(watches.splice(0).map((watch) => watch.close()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
}

/** A throwaway directory by its real path, since the watch reports `/private/var`, not `/var`. */
async function scratch(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "repository-watch-")));
  roots.push(root);
  return root;
}

/** A repository with one committed file and `build/` ignored. */
async function repository(): Promise<string> {
  const root = await scratch();
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "tracked.txt"), "one\n");
  await writeFile(join(root, ".gitignore"), "build/\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "first");
  await mkdir(join(root, "build"));
  return root;
}

/** Every status a subscription is handed, and a way to wait for one that matches. */
function follow(watch: RepositoryGitWatch, directory: string) {
  const seen: (DirectoryGitStatus | null)[] = [];
  const stop = watch.subscribe(directory, (status) => seen.push(status));
  const paths = (status: DirectoryGitStatus | null | undefined) =>
    (status?.entries ?? []).map((entry) => entry.relativePath).sort();
  return {
    seen,
    stop,
    paths,
    async until(accept: (status: DirectoryGitStatus | null) => boolean) {
      await until(() => seen.some(accept), "a matching status").catch((error: unknown) => {
        throw new Error(`${String(error)}; saw ${JSON.stringify(seen.map(paths))}`);
      });
    },
  };
}

function watcher(source: RepositoryEventSource): RepositoryGitWatch {
  const watch = new RepositoryGitWatch({ source, quietMs: 50, longestWaitMs: 200 });
  watches.push(watch);
  return watch;
}

// Both sources run on every platform here, so the one a platform does not pick is still proven.
for (const source of ["tree", "folders"] as const) {
  test(`${source}: answers the current status, then every change git would report`, async () => {
    const root = await repository();
    const reader = follow(watcher(source), root);
    await reader.until((status) => status !== null && status.entries.length === 0);

    await writeFile(join(root, "tracked.txt"), "two\n");
    await reader.until((status) => reader.paths(status).includes("tracked.txt"));

    await git(root, "commit", "-am", "second");
    const clean = reader.seen.length;
    await reader.until((status) => reader.seen.indexOf(status) >= clean && reader.paths(status).length === 0);
  });

  test(`${source}: sees a file written into a directory made after the last listing`, async () => {
    const root = await repository();
    const reader = follow(watcher(source), root);
    await reader.until((status) => status !== null);

    // The directories exist, empty, before the file does: git lists neither until the write. The
    // watch reads the status again for a new directory, so the write waits for that read and
    // lands after the last listing rather than in the same burst as the mkdir.
    const listed = reader.seen.length;
    await mkdir(join(root, "fresh", "deeper"), { recursive: true });
    await until(() => reader.seen.length > listed, "the read the new directories set off");
    // Written until seen. `folders` adopts a new directory by opening a watch on it, and on macOS a
    // write in that watch's first ~100ms is lost, not late (measured 2026-10-18, see watchTree's
    // tests). Linux, where `folders` is the source in use, adds an inotify watch at once.
    const written = join(root, "fresh", "deeper", "new.txt");
    await until(async () => {
      await writeFile(written, "x");
      return reader.seen.some((status) => reader.paths(status).includes("fresh/deeper/new.txt"));
    }, "the new file in a status");
  });

  test(`${source}: asks git nothing for a write git ignores`, async () => {
    const root = await repository();
    const watch = watcher(source);
    const reader = follow(watch, root);
    await reader.until((status) => status !== null);

    // Asked of the watch itself, not of how long nothing happened: waiting a while and counting
    // statuses proved nothing a busy machine could not also produce (2026-10-19).
    const inside = watch as unknown as {
      repositories: Map<string, Promise<{ folders: Set<string> }>>;
      consider(repository: unknown, path: string): Promise<void>;
      schedule(repository: unknown): void;
    };
    if (source === "folders") {
      // One watch per directory git lists, and git lists no ignored one, so a write there never
      // reaches the watch at all.
      const repository = await inside.repositories.get(root);
      expect(repository?.folders.has(root)).toBe(true);
      expect(repository?.folders.has(join(root, "build"))).toBe(false);
      return;
    }

    // One watch for the whole tree, so every write arrives and goes through `consider`, which books
    // a git read through `schedule` or drops the path.
    const consider = inside.consider.bind(watch);
    const considered: { path: string; done: Promise<void> }[] = [];
    spyOn(inside, "consider").mockImplementation((repository, path) => {
      const done = consider(repository, path);
      considered.push({ path, done });
      return done;
    });
    const schedule = inside.schedule.bind(watch);
    let booked = 0;
    spyOn(inside, "schedule").mockImplementation((repository) => {
      booked += 1;
      schedule(repository);
    });

    const written = [0, 1, 2, 3, 4].map((n) => join(root, "build", `out-${n}.js`));
    for (const path of written) await writeFile(path, "x");
    await until(
      () => written.every((path) => considered.some((seen) => seen.path === path)),
      "the watch to consider every ignored write",
    );
    await Promise.all(considered.map((seen) => seen.done));

    // Nothing but ignored paths went through here, or the count would say nothing about them.
    const build = join(root, "build");
    expect(
      considered.map((seen) => seen.path).filter((path) => path !== build && !path.startsWith(`${build}/`)),
    ).toEqual([]);
    expect(booked).toBe(0);
  });
}

test("readers of two directories in one repository share one watch and one status", async () => {
  const root = await repository();
  await mkdir(join(root, "package"));
  await writeFile(join(root, "package", "index.ts"), "x");
  const watch = watcher("tree");
  const top = follow(watch, root);
  const inner = follow(watch, join(root, "package"));

  await top.until((status) => top.paths(status).includes("package/index.ts"));
  await inner.until((status) => inner.paths(status).includes("package/index.ts"));
});

test("a directory outside any repository answers null, then a status once it becomes one", async () => {
  const root = await scratch();
  const reader = follow(watcher("folders"), root);
  await reader.until((status) => status === null);

  await writeFile(join(root, "notes.md"), "x");
  await git(root, "init", "--initial-branch=main");
  await reader.until((status) => reader.paths(status).includes("notes.md"));
});

test("a reader that left hears nothing more", async () => {
  const root = await repository();
  const watch = watcher("tree");
  const reader = follow(watch, root);
  // Still subscribed, so it shows the change below was read and handed out.
  const witness = follow(watch, root);
  await reader.until((status) => status !== null);
  reader.stop();
  const before = reader.seen.length;

  await writeFile(join(root, "tracked.txt"), "changed while nobody listened\n");
  await witness.until((status) => witness.paths(status).includes("tracked.txt"));
  expect(reader.seen.length).toBe(before);
  witness.stop();
});
