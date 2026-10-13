import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimRunFolder,
  nextRunName,
  releaseRunFolder,
  runFolderName,
  runNameFor,
} from "@/arena/arenaRunFolders";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "arena-home-"));
  roots.push(created);
  return join(await realpath(created), ".arena");
}

test("a name gives its folder in lower case, each run of other characters one hyphen", () => {
  expect(runFolderName("arena run 3")).toBe("arena-run-3");
  expect(runFolderName("  Bake off: Opus vs GPT!  ")).toBe("bake-off-opus-vs-gpt");
  expect(runFolderName("../../etc")).toBe("etc");
  expect(runFolderName("!!!")).toBe("");
  expect(runFolderName("a".repeat(100)).length).toBe(64);
});

test("the next name counts past default names and default folders, whichever is higher", async () => {
  const at = await home();
  expect(nextRunName(at, [])).toBe("arena run 1");
  expect(nextRunName(at, ["arena run 2", "Arena Run 4", "my duel"])).toBe("arena run 5");
  await mkdir(join(at, "arena-run-9"), { recursive: true });
  expect(nextRunName(at, ["arena run 2"])).toBe("arena run 10");
});

test("a run asking for no name gets the next one; spaces collapse; a taken folder name is refused", async () => {
  const at = await home();
  expect(runNameFor(undefined, at, ["arena run 1"])).toEqual({ name: "arena run 2", folderName: "arena-run-2" });
  expect(runNameFor("  my   duel ", at, [])).toEqual({ name: "my duel", folderName: "my-duel" });
  expect(runNameFor("My-Duel", at, ["my duel"])).toEqual({
    problem: `there is already a run named like "My-Duel"; name this one something else`,
  });
});

test("claiming a folder makes it, once: the second claim of one name gets nothing", async () => {
  const at = await home();
  const path = claimRunFolder(at, "arena-run-1");
  expect(path).toBe(join(at, "arena-run-1"));
  expect(existsSync(join(at, "arena-run-1"))).toBe(true);
  expect(claimRunFolder(at, "arena-run-1")).toBeNull();
  expect(() => claimRunFolder(at, "../escape")).toThrow(/not a run folder name/);
});

test("releasing removes the run's own repository whole, and a worktree-only folder only when empty", async () => {
  const at = await home();
  const own = claimRunFolder(at, "own")!;
  await writeFile(join(own, "README"), "x\n");
  releaseRunFolder(at, own, true);
  expect(existsSync(own)).toBe(false);

  const named = claimRunFolder(at, "named")!;
  await writeFile(join(named, "stray"), "x\n");
  expect(() => releaseRunFolder(at, named, false)).toThrow(/ENOTEMPTY|not empty/);
  expect(existsSync(join(named, "stray"))).toBe(true);
});

test("releasing refuses any path that is not a run folder directly in the home", async () => {
  const at = await home();
  expect(() => releaseRunFolder(at, join(at, "a", "b"), true)).toThrow(/not a run folder/);
  expect(() => releaseRunFolder(at, at, true)).toThrow(/not a run folder/);
  expect(() => releaseRunFolder(at, join(at, ".git"), true)).toThrow(/not a run folder/);
});
