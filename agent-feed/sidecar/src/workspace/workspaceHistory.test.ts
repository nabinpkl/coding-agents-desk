import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitDetail,
  commitFileDiff,
  listCommits,
  parseCommits,
  parseNameStatus,
  parseNumstat,
} from "@/workspace/workspaceHistory";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function run(root: string, args: string[]): Promise<void> {
  await Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited;
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workspace-history-"));
  roots.push(root);
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
  ]) await run(root, args);
  return root;
}

const FIELD = "\u001f";

function record(fields: string[]): string {
  return `${fields.join(FIELD)}\0`;
}

test("reads a log record's fields, and counts parents from the parent list", () => {
  const output = record(["a".repeat(40), "aaaaaaa", "Ada", "1700000000", "", "first commit"])
    + record(["b".repeat(40), "bbbbbbb", "Ada", "1700000100", "a".repeat(40), "second"])
    + record([
      "c".repeat(40),
      "ccccccc",
      "Grace",
      "1700000200",
      `${"a".repeat(40)} ${"b".repeat(40)}`,
      "Merge branch 'x'",
    ]);
  expect(parseCommits(output).map((commit) => [commit.shortHash, commit.parentCount, commit.subject]))
    .toEqual([["aaaaaaa", 0, "first commit"], ["bbbbbbb", 1, "second"], ["ccccccc", 2, "Merge branch 'x'"]]);
});

test("keeps a subject that contains a newline, which is why the records are NUL-separated", () => {
  const output = record(["a".repeat(40), "aaaaaaa", "Ada", "1700000000", "", "one\ntwo"]);
  expect(parseCommits(output)[0]!.subject).toBe("one\ntwo");
});

test("reports a rename at its new path, and cuts the similarity score off the status", () => {
  expect(parseNameStatus("M\0kept.ts\0R099\0old.ts\0new.ts\0A\0added.ts\0")).toEqual([
    { path: "kept.ts", status: "M", additions: null, deletions: null, previousPath: null },
    { path: "new.ts", status: "R", additions: null, deletions: null, previousPath: "old.ts" },
    { path: "added.ts", status: "A", additions: null, deletions: null, previousPath: null },
  ]);
});

test("counts a rename against its new path, and leaves a binary file uncounted", () => {
  const counts = parseNumstat("3\t1\tkept.ts\0" + "2\t2\t\0old.ts\0new.ts\0" + "-\t-\timage.png\0");
  expect(counts.get("kept.ts")).toEqual({ additions: 3, deletions: 1 });
  expect(counts.get("new.ts")).toEqual({ additions: 2, deletions: 2 });
  // Null rather than zero: a binary file did change, git simply cannot say by how many lines.
  expect(counts.get("image.png")).toEqual({ additions: null, deletions: null });
});

test("lists commits newest first, with the fields the panel draws", async () => {
  const root = await repository();
  await writeFile(join(root, "a.ts"), "one\n");
  await run(root, ["add", "."]);
  await run(root, ["commit", "-m", "add a"]);
  await writeFile(join(root, "a.ts"), "one\ntwo\n");
  await run(root, ["commit", "-am", "extend a"]);

  const commits = await listCommits(root, 10);
  expect(commits.map((commit) => commit.subject)).toEqual(["extend a", "add a"]);
  expect(commits[0]!.hash).toMatch(/^[0-9a-f]{40}$/);
  expect(commits[0]!.shortHash.length).toBeLessThan(commits[0]!.hash.length);
  expect(commits[0]!.author).toBe("Test");
  expect(commits[0]!.committedAt).toBeGreaterThan(0);
});

test("answers an empty history for a directory git does not track", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-history-plain-"));
  roots.push(root);
  expect(await listCommits(root, 10)).toEqual([]);
});

test("reads what one commit touched, with the counts and the path it came from", async () => {
  const root = await repository();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/a.ts"), "one\ntwo\n");
  await writeFile(join(root, "gone.ts"), "x\n");
  await run(root, ["add", "."]);
  await run(root, ["commit", "-m", "first"]);

  await run(root, ["mv", "src/a.ts", "src/b.ts"]);
  await run(root, ["rm", "gone.ts"]);
  await writeFile(join(root, "new.ts"), "fresh\n");
  await run(root, ["add", "."]);
  await run(root, ["commit", "-m", "second"]);

  const [second] = await listCommits(root, 1);
  const detail = await commitDetail(root, "w-1", second!.hash);
  const byPath = new Map(detail.files.map((file) => [file.path, file]));
  expect(byPath.get("src/b.ts")).toMatchObject({ status: "R", previousPath: "src/a.ts" });
  expect(byPath.get("gone.ts")).toMatchObject({ status: "D", additions: 0, deletions: 1 });
  expect(byPath.get("new.ts")).toMatchObject({ status: "A", additions: 1, deletions: 0 });
});

test("reads the message under the subject, and answers empty for a commit with none", async () => {
  const root = await repository();
  await writeFile(join(root, "a.ts"), "one\n");
  await run(root, ["add", "."]);
  await run(root, ["commit", "-m", "subject line\n\nwhy this happened\n\nand a second paragraph"]);
  await writeFile(join(root, "a.ts"), "two\n");
  await run(root, ["commit", "-am", "no body at all"]);

  const [bare, withBody] = await listCommits(root, 2);
  // The subject stays on the commit rather than being repeated here, and the blank line between
  // the author's two paragraphs is theirs to keep.
  expect((await commitDetail(root, "w-1", withBody!.hash)).body)
    .toBe("why this happened\n\nand a second paragraph");
  expect((await commitDetail(root, "w-1", bare!.hash)).body).toBe("");
});

test("reads a merge against its first parent, where a combined diff would show nothing", async () => {
  const root = await repository();
  await writeFile(join(root, "base.ts"), "base\n");
  await run(root, ["add", "."]);
  await run(root, ["commit", "-m", "base"]);
  await run(root, ["checkout", "-b", "side"]);
  await writeFile(join(root, "side.ts"), "side\n");
  await run(root, ["add", "."]);
  await run(root, ["commit", "-m", "side work"]);
  await run(root, ["checkout", "main"]);
  await run(root, ["merge", "--no-ff", "side", "-m", "merge side"]);

  const [merge] = await listCommits(root, 1);
  expect(merge!.parentCount).toBe(2);
  expect((await commitDetail(root, "w-1", merge!.hash)).files.map((file) => file.path))
    .toEqual(["side.ts"]);
});

test("answers the patch for one path, and only that path", async () => {
  const root = await repository();
  await writeFile(join(root, "a.ts"), "one\n");
  await writeFile(join(root, "b.ts"), "other\n");
  await run(root, ["add", "."]);
  await run(root, ["commit", "-m", "first"]);
  await writeFile(join(root, "a.ts"), "one\ntwo\n");
  await writeFile(join(root, "b.ts"), "other\nmore\n");
  await run(root, ["commit", "-am", "second"]);

  const [second] = await listCommits(root, 1);
  const diff = await commitFileDiff(root, "w-1", second!.hash, "a.ts");
  expect(diff.patch).toContain("+two");
  expect(diff.patch).not.toContain("+more");
  expect(diff.truncated).toBe(false);
});

test("refuses a hash that is not one, before it reaches an argument list", async () => {
  const root = await repository();
  await writeFile(join(root, "a.ts"), "one\n");
  await run(root, ["add", "."]);
  await run(root, ["commit", "-m", "first"]);
  await expect(commitDetail(root, "w-1", "--output=/tmp/escape")).rejects.toThrow("invalid");
  await expect(commitFileDiff(root, "w-1", "HEAD", "a.ts")).rejects.toThrow("invalid");
});

test("refuses a path that tries to leave the workspace", async () => {
  const root = await repository();
  await writeFile(join(root, "a.ts"), "one\n");
  await run(root, ["add", "."]);
  await run(root, ["commit", "-m", "first"]);
  const [first] = await listCommits(root, 1);
  await expect(commitFileDiff(root, "w-1", first!.hash, "../outside.ts")).rejects.toThrow("invalid");
});
