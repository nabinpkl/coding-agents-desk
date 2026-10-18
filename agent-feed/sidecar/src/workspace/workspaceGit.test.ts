import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitStatus, parsePorcelain, readGitStatus, statusForPath, workingTreeFileDiff } from "@/workspace/workspaceGit";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workspace-git-"));
  roots.push(root);
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
  ]) {
    await Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited;
  }
  return root;
}

test("reads an index status and a worktree status apart", () => {
  expect(parsePorcelain("M  staged.ts\0 M unstaged.ts\0MM both.ts\0?? new.ts\0")).toEqual([
    { relativePath: "staged.ts", indexStatus: "M", workTreeStatus: null },
    { relativePath: "unstaged.ts", indexStatus: null, workTreeStatus: "M" },
    { relativePath: "both.ts", indexStatus: "M", workTreeStatus: "M" },
    { relativePath: "new.ts", indexStatus: "?", workTreeStatus: "?" },
  ]);
});

test("reports a rename at its new path and skips the source record", () => {
  expect(parsePorcelain("R  new.ts\0old.ts\0M  other.ts\0")).toEqual([
    { relativePath: "new.ts", indexStatus: "R", workTreeStatus: null },
    { relativePath: "other.ts", indexStatus: "M", workTreeStatus: null },
  ]);
});

test("keeps a path that contains a space or a newline intact", () => {
  expect(parsePorcelain("M  a file.ts\0?? with\nnewline.ts\0").map((e) => e.relativePath)).toEqual([
    "a file.ts",
    "with\nnewline.ts",
  ]);
});

test("ignores an empty trailing record", () => {
  expect(parsePorcelain("")).toEqual([]);
  expect(parsePorcelain("\0")).toEqual([]);
});

test("a directory wears the status of something inside it, without claiming a sibling", () => {
  const entries = parsePorcelain("M  src/app/main.ts\0?? src-generated/other.ts\0");
  expect(statusForPath(entries, "src/app/main.ts")).toBe("M");
  expect(statusForPath(entries, "src/app")).toBe("M");
  expect(statusForPath(entries, "src")).toBe("M");
  expect(statusForPath(entries, "src-generated")).toBe("??");
  expect(statusForPath(entries, "docs")).toBe(null);
});

test("a directory that is not a repository has an empty status rather than failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-git-plain-"));
  roots.push(root);
  expect(await gitStatus("w1", root)).toEqual({ workspaceId: "w1", branch: null, entries: [] });
});

test("reads real status and branch out of a real repository", async () => {
  const root = await repository();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "export {};\n");

  const status = await gitStatus("w1", root);
  expect(status.branch).toBe("main");
  expect(status.entries).toEqual([{ relativePath: "src/main.ts", indexStatus: "?", workTreeStatus: "?" }]);
});

async function run(root: string, ...args: string[]): Promise<void> {
  const code = await Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
}

test("a directory outside any repository reads as no repository, not as a clean one", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-git-none-"));
  roots.push(root);
  expect(await readGitStatus(root)).toBe(null);
});

test("diffs a tracked change against HEAD, staged and unstaged together", async () => {
  const root = await repository();
  await writeFile(join(root, "a.ts"), "one\n");
  await run(root, "add", "a.ts");
  await run(root, "commit", "-m", "first");
  await writeFile(join(root, "a.ts"), "one\ntwo\n");
  await run(root, "add", "a.ts");
  await writeFile(join(root, "a.ts"), "one\ntwo\nthree\n");

  const { patch, truncated } = await workingTreeFileDiff(root, "a.ts");
  expect(truncated).toBe(false);
  expect(patch).toContain("+two\n+three\n");
});

test("shows an untracked file whole, and answers from a subdirectory by the top's path", async () => {
  const root = await repository();
  await mkdir(join(root, "sub"));
  await writeFile(join(root, "sub", "new.ts"), "fresh\n");

  // The Bot's directory is `sub`, and porcelain names the file from the repository's top.
  const { patch } = await workingTreeFileDiff(join(root, "sub"), "sub/new.ts");
  expect(patch).toContain("+fresh");
});

test("diffs a staged file in a repository with no commits yet", async () => {
  const root = await repository();
  await writeFile(join(root, "first.ts"), "hello\n");
  await run(root, "add", "first.ts");

  expect((await workingTreeFileDiff(root, "first.ts")).patch).toContain("+hello");
});

test("refuses a path that has no uncommitted change", async () => {
  const root = await repository();
  await writeFile(join(root, "a.ts"), "one\n");
  await run(root, "add", "a.ts");
  await run(root, "commit", "-m", "first");

  await expect(workingTreeFileDiff(root, "a.ts")).rejects.toThrow("not found");
  await expect(workingTreeFileDiff(root, "../etc/passwd")).rejects.toThrow("invalid");
});
