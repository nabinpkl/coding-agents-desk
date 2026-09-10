import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateRoot,
  WORKSPACE_STORE_VERSION,
  WorkspaceStore,
  WorkspaceStoreError,
} from "@/workspace/workspaceStore";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workspace-store-"));
  roots.push(root);
  return root;
}

async function store(): Promise<{ store: WorkspaceStore; path: string }> {
  const directory = await scratch();
  const path = join(directory, "workspaces.json");
  const created = new WorkspaceStore(path);
  await created.ready;
  return { store: created, path };
}

test("a store with no file is an empty roster, not a failure", async () => {
  const { store: created } = await store();
  expect(created.list()).toEqual([]);
});

test("adds a root and names it after its last path component", async () => {
  const { store: created } = await store();
  const project = await scratch();

  const workspace = await created.add(project);
  expect(workspace.root).toBe(project);
  expect(workspace.name).toBe(project.split("/").pop()!);
  expect(created.get(workspace.id)).toEqual(workspace);
});

test("adding the same root twice returns the workspace already registered", async () => {
  const { store: created } = await store();
  const project = await scratch();

  const first = await created.add(project);
  const second = await created.add(project, "another name");
  expect(second.id).toBe(first.id);
  expect(created.list()).toHaveLength(1);
});

test("refuses a root that does not exist, is a file, or is a symlink", async () => {
  const project = await scratch();
  await writeFile(join(project, "file.txt"), "");
  await symlink(project, join(project, "self"));

  await expect(validateRoot(join(project, "absent"))).rejects.toThrow(WorkspaceStoreError);
  await expect(validateRoot(join(project, "file.txt"))).rejects.toThrow(WorkspaceStoreError);
  await expect(validateRoot(join(project, "self"))).rejects.toThrow(WorkspaceStoreError);
});

test("survives a reload, because the roster is what is on disk", async () => {
  const { store: created, path } = await store();
  const project = await scratch();
  const workspace = await created.add(project, "Project");

  const reopened = new WorkspaceStore(path);
  await reopened.ready;
  expect(reopened.list()).toEqual([workspace]);
});

test("refuses a store file written by something else rather than emptying it", async () => {
  const directory = await scratch();
  const path = join(directory, "workspaces.json");
  await writeFile(path, JSON.stringify({ version: 99, workspaces: [] }));

  await expect(new WorkspaceStore(path).ready).rejects.toThrow(WorkspaceStoreError);
});

test("refuses a store file that is not JSON", async () => {
  const directory = await scratch();
  const path = join(directory, "workspaces.json");
  await writeFile(path, "not json");

  await expect(new WorkspaceStore(path).ready).rejects.toThrow(WorkspaceStoreError);
});

test("removes and renames, and tells its subscribers", async () => {
  const { store: created } = await store();
  const project = await scratch();
  const seen: number[] = [];
  const stop = created.subscribe((workspaces) => seen.push(workspaces.length));

  const workspace = await created.add(project);
  await created.rename(workspace.id, "Renamed");
  expect(created.get(workspace.id)?.name).toBe("Renamed");
  await created.remove(workspace.id);
  expect(created.list()).toEqual([]);

  stop();
  expect(seen).toEqual([1, 1, 0]);
});

test("refuses to remove or rename a workspace that is not there", async () => {
  const { store: created } = await store();
  await expect(created.remove("nope")).rejects.toThrow(WorkspaceStoreError);
  await expect(created.rename("nope", "x")).rejects.toThrow(WorkspaceStoreError);
});

test("a reorder must be a permutation, so nothing is dropped by omission", async () => {
  const { store: created } = await store();
  const first = await created.add(await scratch(), "first");
  const second = await created.add(await scratch(), "second");

  await created.reorder([second.id, first.id]);
  expect(created.list().map((workspace) => workspace.name)).toEqual(["second", "first"]);

  await expect(created.reorder([first.id])).rejects.toThrow(WorkspaceStoreError);
  await expect(created.reorder([first.id, first.id])).rejects.toThrow(WorkspaceStoreError);
});

test("writes the version it will refuse to read without", async () => {
  const { store: created, path } = await store();
  await created.add(await scratch());

  const written: unknown = JSON.parse(await readFile(path, "utf8"));
  expect((written as { version: number }).version).toBe(WORKSPACE_STORE_VERSION);
});
