import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceStreamEvent } from "@agentdesk/agent-feed-wire";
import { WorkspaceSharedStateStore } from "@/workspace/workspaceSharedState";
import { WorkspaceService } from "@/workspace/workspaceService";
import { WorkspaceStore } from "@/workspace/workspaceStore";

const scratches: string[] = [];
const services: WorkspaceService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(scratches.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * A throwaway directory, by its real path.
 *
 * `realpath` and not just `mkdtemp`, because macOS puts the temporary directory behind a symlink
 * (`/var` -> `/private/var`) and the watcher reports the resolved path. Comparing a watch event
 * against an unresolved root makes every event look like it belongs to another workspace.
 */
async function scratch(prefix: string): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  scratches.push(path);
  return path;
}

/**
 * A service over a throwaway project, plus the changed-path sets its stream reports.
 *
 * The events are collected rather than awaited one at a time because a save is several filesystem
 * events coalesced into one `changed`; a test that waited for the first one would be asserting on
 * whichever event chokidar happened to deliver first.
 */
async function serviceOver(project: string) {
  const state = await scratch("workspace-service-state-");
  const store = new WorkspaceStore(join(state, "workspaces.json"));
  const shared = new WorkspaceSharedStateStore(join(state, "workspace-state.json"));
  const service = new WorkspaceService(store, shared);
  services.push(service);
  await service.ready();
  const workspace = await store.add(project);
  const changed: string[][] = [];
  service.subscribe((event: WorkspaceStreamEvent) => {
    if (event.type === "changed") changed.push([...event.changedPaths]);
  });
  // A write before the watcher is ready is reported by nobody: too late for the first pass and
  // too early to be an event. Waiting here is what makes the assertions below deterministic.
  await service.whenWatching();
  return { service, shared, workspace, changed };
}

test("a workspace root is watchable immediately, however large the tree beneath it", async () => {
  // The regression this pins: a recursive watch of a real repository took 54 seconds to become
  // ready under Bun and starved the event loop throughout, so the sidecar failed its readiness
  // probe and was killed and respawned into the same 54 seconds. One roster entry was enough to
  // make every surface go dark. A watch one directory deep is ready in milliseconds instead.
  const project = await scratch("workspace-service-project-");
  await mkdir(join(project, "deep", "deeper", "deepest"), { recursive: true });
  for (let n = 0; n < 200; n += 1) {
    await writeFile(join(project, "deep", "deeper", "deepest", `file-${n}.txt`), "x");
  }

  const started = Date.now();
  const { service } = await serviceOver(project);

  expect(Date.now() - started).toBeLessThan(5_000);
  expect(service.watchedDirectories).toEqual([project]);
});

test("watches a directory when it is expanded, and nothing underneath a collapsed one", async () => {
  // Watching exactly what the tree draws is one rule rather than two: `buildTree` descends only
  // into expanded directories, so a change under a collapsed one has nowhere to be drawn and
  // nothing to say. Asserting the watched set rather than a round trip through the filesystem,
  // because the round trip measures the operating system's delivery schedule and not this rule.
  const project = await scratch("workspace-service-project-");
  await mkdir(join(project, "src", "nested"), { recursive: true });
  const { service, shared, workspace } = await serviceOver(project);
  expect(service.watchedDirectories).toEqual([project]);

  await shared.apply(workspace.id, 0, "op-expand", { type: "expand", path: "src" });
  expect(service.watchedDirectories).toEqual([project, join(project, "src")]);
  // Its child is inside a watched directory but is not itself expanded, so it stays unwatched.
  expect(service.watchedDirectories).not.toContain(join(project, "src", "nested"));

  await shared.apply(workspace.id, 1, "op-nested", { type: "expand", path: "src/nested" });
  expect(service.watchedDirectories).toContain(join(project, "src", "nested"));
});

test("an expanded path that could not have come from this tree is refused, not watched", async () => {
  // Expanded paths arrive from an unauthenticated client. One that escapes the root is already
  // absent from the tree the same state produced, so declining to watch it agrees with what the
  // reader can see -- and never turns shared state into a watch on someone else's directory.
  const project = await scratch("workspace-service-project-");
  const { service, shared, workspace } = await serviceOver(project);

  await expect(
    shared.apply(workspace.id, 0, "op-escape", { type: "expand", path: "../escape" }),
  ).rejects.toThrow();

  expect(service.watchedDirectories).toEqual([project]);
});
