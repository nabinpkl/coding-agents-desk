import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeScratchFolder, removeScratchFolder, scratchSlug } from "@/scratch/scratchFolders";

const made: string[] = [];

async function root(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "scratch-folders-")));
  made.push(path);
  return join(path, "scratch");
}

afterEach(async () => {
  for (const path of made.splice(0)) await rm(path, { recursive: true, force: true });
});

test("a folder's name is the title's words and a random suffix", async () => {
  const scratch = await root();
  const folder = await makeScratchFolder("Compare Bun and Node watchers!", scratch);
  expect(folder.startsWith(join(scratch, "compare-bun-and-node-watchers-"))).toBe(true);
  expect(folder).toMatch(/-[0-9a-f]{4}$/);
  expect((await stat(folder)).isDirectory()).toBe(true);
  expect(await readdir(folder)).toEqual([]);
});

test("two chats with one title get two folders", async () => {
  const scratch = await root();
  const first = await makeScratchFolder("Same question", scratch);
  const second = await makeScratchFolder("Same question", scratch);
  expect(first).not.toBe(second);
  expect((await readdir(scratch)).length).toBe(2);
});

test("a title with no letters or digits still names a folder", () => {
  expect(scratchSlug("¿¿??")).toBe("chat");
  expect(scratchSlug("Café déjà vu")).toBe("cafe-deja-vu");
});

test("a long title is cut at a word", () => {
  const slug = scratchSlug("one two three four five six seven eight nine ten eleven twelve");
  expect(slug.length).toBeLessThanOrEqual(40);
  expect(slug.endsWith("-")).toBe(false);
  expect("one-two-three-four-five-six-seven-eight-nine-ten".startsWith(slug)).toBe(true);
});

test("removing takes only an empty folder, and only one under the root", async () => {
  const scratch = await root();
  const empty = await makeScratchFolder("empty", scratch);
  await removeScratchFolder(empty, scratch);
  expect(await readdir(scratch)).toEqual([]);

  const written = await makeScratchFolder("written", scratch);
  await writeFile(join(written, "notes.md"), "kept");
  await expect(removeScratchFolder(written, scratch)).rejects.toThrow();
  expect(await readdir(written)).toEqual(["notes.md"]);

  await expect(removeScratchFolder(join(scratch, "..", "elsewhere"), scratch)).rejects.toThrow(
    "is not a scratch folder",
  );
});
