import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseDirectories } from "@/workspace/workspaceBrowse";

let home: string;
let outside: string;

beforeEach(async () => {
  // `realpath` because macOS puts the temporary directory behind a `/var` -> `/private/var`
  // symlink, and this module resolves before it compares.
  home = await realpath(await mkdtemp(join(tmpdir(), "browse-home-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "browse-outside-")));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/** Every case here is about the confinement, so the root is always the scratch home. */
const listing = (path: string | null) => browseDirectories(path, home);

test("lists directories and leaves files out, because only a directory can be a workspace", async () => {
  await mkdir(join(home, "projects"));
  await writeFile(join(home, "notes.txt"), "x");

  const home_listing = await listing(null);

  expect(home_listing.entries.map((entry) => entry.name)).toEqual(["projects"]);
  expect(home_listing.path).toBe(home);
});

test("offers no way up from the root, and one from anywhere below it", async () => {
  await mkdir(join(home, "projects"));

  expect((await listing(null)).parent).toBeNull();
  expect((await listing(join(home, "projects"))).parent).toBe(home);
});

test("sorts dot-directories last rather than hiding them", async () => {
  // Hiding them would be the easy call and the wrong one: a picker that silently omits a folder
  // the reader can see in Finder reads as broken, and some people keep projects in `.config`.
  await mkdir(join(home, ".config"));
  await mkdir(join(home, "work"));
  await mkdir(join(home, "Archive"));

  const names = (await listing(null)).entries.map((entry) => entry.name);

  expect(names).toEqual(["Archive", "work", ".config"]);
});

test("refuses a path outside the home directory", async () => {
  expect(listing(outside)).rejects.toThrow();
});

test("refuses a symlink that points out of the home directory", async () => {
  // The check is against the RESOLVED path for exactly this: a link inside home would otherwise
  // satisfy a check on the name it was asked about and then list somewhere else entirely.
  await symlink(outside, join(home, "escape"));

  expect(listing(join(home, "escape"))).rejects.toThrow();
});

test("refuses a file and a path that is not there", async () => {
  await writeFile(join(home, "notes.txt"), "x");

  expect(listing(join(home, "notes.txt"))).rejects.toThrow();
  expect(listing(join(home, "nope"))).rejects.toThrow();
});
