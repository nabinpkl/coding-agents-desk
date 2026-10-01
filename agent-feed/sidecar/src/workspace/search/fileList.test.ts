import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ripgrepBinary } from "@/config/configBinaries";
import { listFiles } from "@/workspace/search/fileList";
import { runRipgrep, SearchFailure } from "@/workspace/search/ripgrep";

const rg = ripgrepBinary();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workspace-files-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

test.skipIf(!rg)("lists files relative to the root, sorted, dotfiles in, excluded names out", async () => {
  const root = await project({
    "src/b.ts": "",
    "src/a.ts": "",
    ".github/workflows/ci.yml": "",
    "app/node_modules/pkg/index.js": "",
    ".git/HEAD": "",
    "dist/out.js": "",
    ".gitignore": "dist/\n",
  });
  const { files, truncated } = await listFiles(rg, root);
  // `.gitignore` applies although there is no repository here: the shipped peer copy has no `.git`.
  expect(files).toEqual([".github/workflows/ci.yml", ".gitignore", "src/a.ts", "src/b.ts"]);
  expect(truncated).toBe(false);
});

test.skipIf(!rg)("an ignore file above the root does not reach into it", async () => {
  // This Mac's `~/.gitignore` is `*`; honouring it hid every file of every workspace.
  const parent = await project({ ".gitignore": "*\n" });
  await mkdir(join(parent, "workspace"));
  await writeFile(join(parent, "workspace", "main.ts"), "");
  expect((await listFiles(rg, join(parent, "workspace"))).files).toEqual(["main.ts"]);
});

test.skipIf(!rg)("a symlink is not offered, even one pointing outside the root", async () => {
  const root = await project({ "real.txt": "" });
  await symlink("/etc/hosts", join(root, "hosts"));
  expect((await listFiles(rg, root)).files).toEqual(["real.txt"]);
});

test.skipIf(!rg)("a file name holding a newline survives, because records are NUL-separated", async () => {
  const root = await project({ "odd\nname.txt": "" });
  expect((await listFiles(rg, root)).files).toEqual(["odd\nname.txt"]);
});

test("a machine with no rg is told so, rather than answered with nothing", async () => {
  const failure = await listFiles(null, tmpdir()).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SearchFailure);
  expect((failure as SearchFailure).code).toBe("searchUnavailable");
});

test.skipIf(!rg)("an aborted search stops without an answer being an error", async () => {
  const root = await project({ "a.txt": "" });
  const controller = new AbortController();
  controller.abort();
  const run = await runRipgrep(rg, ["--files", "."], root, () => true, {
    separator: "\n",
    signal: controller.signal,
  });
  expect(run.stopped).toBe(true);
});
