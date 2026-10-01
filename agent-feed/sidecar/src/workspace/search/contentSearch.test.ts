import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSearchOptions } from "@agentdesk/agent-feed-wire";
import { ripgrepBinary } from "@/config/configBinaries";
import {
  MAXIMUM_PREVIEW_CHARACTERS,
  searchContent,
  trimPreview,
} from "@/workspace/search/contentSearch";
import { SearchFailure } from "@/workspace/search/ripgrep";

const rg = ripgrepBinary();
const roots: string[] = [];
const plain: WorkspaceSearchOptions = { matchCase: false, wholeWord: false, regex: false, include: [], exclude: [] };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workspace-search-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

/** Each hit as `path:line:highlighted text`, which is what a reader sees of it. */
function hits(result: Awaited<ReturnType<typeof searchContent>>): string[] {
  return result.files.flatMap((file) =>
    file.matches.map((match) =>
      `${file.path}:${match.line}:${match.ranges.map(([from, to]) => match.preview.slice(from, to)).join("|")}`));
}

test.skipIf(!rg)("a word is found in every file, excluded names skipped, grouped and in line order", async () => {
  const root = await project({
    "src/b.ts": "const alder = 1;\nlet x;\nalder();\n",
    "src/a.ts": "// alder\n",
    "node_modules/pkg/index.js": "alder\n",
  });
  const result = await searchContent(rg, root, "alder", plain);
  expect(hits(result)).toEqual(["src/a.ts:1:alder", "src/b.ts:1:alder", "src/b.ts:3:alder"]);
  expect(result.matchCount).toBe(3);
  expect(result.truncated).toBe(false);
});

test.skipIf(!rg)("smart case: lowercase ignores case, a capital makes it exact, Match case forces it", async () => {
  const root = await project({ "a.txt": "Alder\nalder\n" });
  expect(hits(await searchContent(rg, root, "alder", plain))).toEqual(["a.txt:1:Alder", "a.txt:2:alder"]);
  expect(hits(await searchContent(rg, root, "Alder", plain))).toEqual(["a.txt:1:Alder"]);
  expect(hits(await searchContent(rg, root, "alder", { ...plain, matchCase: true }))).toEqual(["a.txt:2:alder"]);
});

test.skipIf(!rg)("several words match in any order on one line, and all of them are highlighted", async () => {
  const root = await project({ "a.ts": "useWorkspace(ide)\nide only\nworkspace only\nIDE for the workspace\n" });
  expect(hits(await searchContent(rg, root, "workspace ide", plain))).toEqual([
    "a.ts:1:Workspace|ide",
    "a.ts:4:IDE|workspace",
  ]);
  // Quoted keeps the phrase whole.
  expect(hits(await searchContent(rg, root, '"for the"', plain))).toEqual(["a.ts:4:for the"]);
});

test.skipIf(!rg)("whole word and regex", async () => {
  const root = await project({ "a.ts": "cat\nconcatenate\ncat1 cat2\n" });
  expect(hits(await searchContent(rg, root, "cat", { ...plain, wholeWord: true }))).toEqual(["a.ts:1:cat"]);
  expect(hits(await searchContent(rg, root, "cat\\d", { ...plain, regex: true }))).toEqual(["a.ts:3:cat1|cat2"]);
});

test.skipIf(!rg)("include and exclude globs narrow the files", async () => {
  const root = await project({ "a.ts": "x\n", "a.test.ts": "x\n", "b.md": "x\n" });
  expect(hits(await searchContent(rg, root, "x", { ...plain, include: ["*.ts"], exclude: ["*.test.ts"] })))
    .toEqual(["a.ts:1:x"]);
});

test.skipIf(!rg)("a query is text, never a shell command or an rg flag", async () => {
  const root = await project({ "a.txt": "--files\n$(touch pwned); `id`\n" });
  expect(hits(await searchContent(rg, root, "--files", plain))).toEqual(["a.txt:1:--files"]);
  expect(hits(await searchContent(rg, root, "$(touch pwned); `id`", { ...plain, regex: false })))
    .toEqual(["a.txt:2:$(touch|pwned);|`id`"]);
  expect(await Bun.file(join(root, "pwned")).exists()).toBe(false);
});

test.skipIf(!rg)("a regex rg cannot parse is refused with rg's reason", async () => {
  const root = await project({ "a.txt": "x\n" });
  const failure = await searchContent(rg, root, "(", { ...plain, regex: true }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SearchFailure);
  expect((failure as SearchFailure).code).toBe("invalidQuery");
  expect((failure as SearchFailure).message).toContain("unclosed group");
});

test.skipIf(!rg)("highlights land on characters, not bytes, after multi-byte text", async () => {
  const root = await project({ "a.txt": "café → alder\n" });
  expect(hits(await searchContent(rg, root, "alder", plain))).toEqual(["a.txt:1:alder"]);
});

test("a long line is cut to a window around its first hit, and the ranges follow it", () => {
  const line = `${"a".repeat(1000)}NEEDLE${"b".repeat(1000)}`;
  const { preview, ranges, previewOffset } = trimPreview(line, [[1000, 1006]]);
  expect(line.slice(ranges[0]![0] + previewOffset, ranges[0]![1] + previewOffset)).toBe("NEEDLE");
  expect(preview.length).toBeLessThanOrEqual(MAXIMUM_PREVIEW_CHARACTERS + 2);
  expect(preview.startsWith("…")).toBe(true);
  expect(preview.endsWith("…")).toBe(true);
  expect(preview.slice(ranges[0]![0], ranges[0]![1])).toBe("NEEDLE");
});
