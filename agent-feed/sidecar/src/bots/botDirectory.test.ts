import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindableDirectory } from "@/bots/botDirectory";

let home: string;
let outside: string;

beforeEach(async () => {
  // `realpath` because macOS puts the temporary directory behind a `/var` -> `/private/var`
  // symlink, and this module resolves before it compares.
  home = await realpath(await mkdtemp(join(tmpdir(), "bot-home-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "bot-outside-")));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const nothingCatalogued = () => false;

test("binds a directory no session has ever run in", async () => {
  // The whole point of the folder picker: a project with no transcripts yet is not in the
  // catalog, and it is exactly the one a reader wants to name a Bot after and start.
  const fresh = join(home, "fresh-project");
  await mkdir(fresh);

  expect(bindableDirectory(fresh, nothingCatalogued, home)).toEqual({ projectPath: fresh });
});

test("binds a catalogued directory wherever it lives", () => {
  // A session already ran there, so the machine has already answered the question this
  // confinement asks. Refusing it would retire working Bots on the next restart.
  expect(bindableDirectory(outside, (path) => path === outside, home)).toEqual({
    projectPath: outside,
  });
});

test("refuses a directory outside the home the picker lists from", () => {
  expect(bindableDirectory(outside, nothingCatalogued, home)).toBeUndefined();
});

test("refuses a symlink out of home, resolving before it compares", async () => {
  const escape = join(home, "escape");
  await symlink(outside, escape);

  expect(bindableDirectory(escape, nothingCatalogued, home)).toBeUndefined();
});

test("binds the real path, not the link that named it", async () => {
  // A session reports the directory it is actually in, so a Bot bound to the link would watch a
  // path no session will ever report and collect nothing.
  const real = join(home, "real-project");
  await mkdir(real);
  const link = join(home, "link-to-project");
  await symlink(real, link);

  expect(bindableDirectory(link, nothingCatalogued, home)).toEqual({ projectPath: real });
});

test("refuses a file, and a path that is not there at all", async () => {
  const file = join(home, "notes.md");
  await writeFile(file, "not a directory");

  expect(bindableDirectory(file, nothingCatalogued, home)).toBeUndefined();
  expect(bindableDirectory(join(home, "gone"), nothingCatalogued, home)).toBeUndefined();
});
