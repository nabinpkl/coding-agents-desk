import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browseDirectories, createDirectory } from "@/workspace/workspaceBrowse";

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

/** Every case below is about what a name may become, so the parent is always the scratch home. */
const create = (path: string, name: string) => createDirectory(path, name, home);

test("makes a folder and answers with where it now is, empty", async () => {
  await mkdir(join(home, "projects"));

  const listing = await create(join(home, "projects"), "ecc");

  // The listing rather than the path, so the picker can stand in the folder without asking again.
  expect(listing.path).toBe(join(home, "projects", "ecc"));
  expect(listing.parent).toBe(join(home, "projects"));
  expect(listing.entries).toEqual([]);
  expect((await stat(join(home, "projects", "ecc"))).isDirectory()).toBe(true);
});

test("makes a folder at the confinement root itself", async () => {
  // The root is a directory the picker opens first, so creating in it is the most ordinary case of
  // all -- and the one where a confinement check written for "somewhere below" would break.
  const listing = await create(home, "scratch");

  expect(listing.path).toBe(join(home, "scratch"));
  // Its way up is the root, which is what the picker needs to offer: the new folder is below the
  // root, not the root.
  expect(listing.parent).toBe(home);
});

test("refuses a name that is already taken, rather than accepting it as done", async () => {
  await mkdir(join(home, "projects"));
  await mkdir(join(home, "projects", "ecc"));

  // Not `recursive: true`: a silent success would leave the reader believing they had made
  // something they had not, in a folder that was already there.
  expect(create(join(home, "projects"), "ecc")).rejects.toThrow(/already exists/);
});

test("refuses a name carrying a separator or a way up", async () => {
  await mkdir(join(home, "projects"));

  // Each of these asks to create somewhere other than where the reader is looking, which is the
  // walk the confinement exists to refuse, wearing a name.
  expect(create(join(home, "projects"), "../outside")).rejects.toThrow();
  expect(create(join(home, "projects"), "nested/child")).rejects.toThrow();
  expect(create(join(home, "projects"), "..")).rejects.toThrow();
  expect(create(join(home, "projects"), "   ")).rejects.toThrow();
});

test("refuses a parent outside the home directory, or reached through a link out of it", async () => {
  await symlink(outside, join(home, "escape"));

  expect(create(outside, "anywhere")).rejects.toThrow();
  // The parent is resolved before it is checked, exactly as a browse does, so a link inside home
  // cannot become a way to write outside it.
  expect(create(join(home, "escape"), "anywhere")).rejects.toThrow();
});

test("refuses a file as the parent", async () => {
  await writeFile(join(home, "notes.txt"), "x");

  expect(create(join(home, "notes.txt"), "child")).rejects.toThrow();
});
