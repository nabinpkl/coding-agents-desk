import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryEventSource } from "@/workspace/repositoryEvents";
import { RepositoryGitWatch } from "@/workspace/repositoryWatch";
import type { DirectoryGitStatus } from "@/workspace/workspaceGit";

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
    async until(accept: (status: DirectoryGitStatus | null) => boolean, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const match = seen.find(accept);
        if (match !== undefined) return match;
        await Bun.sleep(25);
      }
      throw new Error(`no matching status in ${timeoutMs}ms; saw ${JSON.stringify(seen.map(paths))}`);
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

    // The directories exist, empty, before the file does: git lists neither until the write.
    await mkdir(join(root, "fresh", "deeper"), { recursive: true });
    await Bun.sleep(400);
    await writeFile(join(root, "fresh", "deeper", "new.txt"), "x");
    await reader.until((status) => reader.paths(status).includes("fresh/deeper/new.txt"));
  });

  test(`${source}: asks git nothing for a write git ignores`, async () => {
    const root = await repository();
    const reader = follow(watcher(source), root);
    await reader.until((status) => status !== null);
    await Bun.sleep(300);
    const before = reader.seen.length;

    for (let n = 0; n < 5; n += 1) {
      await writeFile(join(root, "build", `out-${n}.js`), "x");
      await Bun.sleep(50);
    }
    await Bun.sleep(600);
    expect(reader.seen.length).toBe(before);
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
  const reader = follow(watcher("tree"), root);
  await reader.until((status) => status !== null);
  reader.stop();
  const before = reader.seen.length;

  await writeFile(join(root, "tracked.txt"), "changed while nobody listened\n");
  await Bun.sleep(600);
  expect(reader.seen.length).toBe(before);
});
