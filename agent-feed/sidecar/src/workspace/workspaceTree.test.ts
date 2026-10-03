import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTree } from "@/workspace/workspaceTree";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workspace-tree-"));
  roots.push(root);
  await mkdir(join(root, "src", "app"), { recursive: true });
  await writeFile(join(root, "src", "app", "main.tsx"), "");
  await writeFile(join(root, "src", "index.ts"), "");
  await writeFile(join(root, "README.md"), "");
  return root;
}

test("an unexpanded root lists one level and no children", async () => {
  const tree = await buildTree(await project(), [], []);
  expect(tree.map((node) => node.name)).toEqual(["src", "README.md"]);
  expect(tree[0]!.expanded).toBe(false);
  expect(tree[0]!.children).toEqual([]);
});

test("an expanded directory carries its children, and nested expansion nests", async () => {
  const tree = await buildTree(await project(), ["src", "src/app"], []);
  const src = tree[0]!;
  expect(src.expanded).toBe(true);
  expect(src.children.map((node) => node.name)).toEqual(["app", "index.ts"]);
  expect(src.children[0]!.children.map((node) => node.name)).toEqual(["main.tsx"]);
});

test("expanding a directory that is not in the tree changes nothing", async () => {
  const tree = await buildTree(await project(), ["absent"], []);
  expect(tree.every((node) => node.children.length === 0)).toBe(true);
});

test("decorates a file and the directories above it", async () => {
  const tree = await buildTree(await project(), ["src"], [
    { relativePath: "src/index.ts", indexStatus: null, workTreeStatus: "M" },
  ]);
  expect(tree[0]!.gitStatus).toBe("M");
  expect(tree[0]!.children.find((node) => node.name === "index.ts")!.gitStatus).toBe("M");
  expect(tree.find((node) => node.name === "README.md")!.gitStatus).toBe(null);
});

test("every node carries when it last changed, at every level", async () => {
  // The order a reader chooses is decided from this and nowhere else, so a level that forgets it
  // silently loses the only thing that order has to work with.
  const tree = await buildTree(await project(), ["src", "src/app"], []);
  const nested = tree[0]!.children[0]!.children[0]!;
  expect(tree.every((node) => node.modifiedAt > 0)).toBe(true);
  expect(nested.name).toBe("main.tsx");
  expect(nested.modifiedAt).toBeGreaterThan(0);
});
