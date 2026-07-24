import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { publishGeneratedTree } from "./publish-generated-tree.mjs";

async function fixture(run) {
  const root = await mkdtemp(resolve(tmpdir(), "agentdesk-generated-tree-"));
  const source = resolve(root, "source");
  const destination = resolve(root, "destination");
  await Promise.all([
    mkdir(source, { recursive: true }),
    mkdir(destination, { recursive: true }),
  ]);
  try {
    await run({ root, source, destination });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("identical files retain their modification time", async () => {
  await fixture(async ({ source, destination }) => {
    const sourceFile = resolve(source, "app.js");
    const destinationFile = resolve(destination, "app.js");
    await Promise.all([
      writeFile(sourceFile, "same content"),
      writeFile(destinationFile, "same content"),
    ]);
    const retainedTime = new Date("2001-01-01T00:00:00.000Z");
    await utimes(destinationFile, retainedTime, retainedTime);

    const result = await publishGeneratedTree({
      sourceDirectory: source,
      destinationDirectory: destination,
    });

    assert.deepEqual(result, { changed: 0, unchanged: 1, removed: 0 });
    assert.equal((await stat(destinationFile)).mtimeMs, retainedTime.getTime());
  });
});

test("publishes only changed files and removes stale generated entries", async () => {
  await fixture(async ({ source, destination }) => {
    await mkdir(resolve(source, "assets"), { recursive: true });
    await mkdir(resolve(destination, "assets"), { recursive: true });
    await writeFile(resolve(source, "assets/unchanged.js"), "same");
    await writeFile(resolve(destination, "assets/unchanged.js"), "same");
    await writeFile(resolve(source, "assets/changed.js"), "new");
    await writeFile(resolve(destination, "assets/changed.js"), "old");
    await writeFile(resolve(destination, "assets/stale.js"), "stale");
    await writeFile(resolve(destination, ".gitkeep"), "");
    const retainedTime = new Date("2002-02-02T00:00:00.000Z");
    await utimes(resolve(destination, "assets/unchanged.js"), retainedTime, retainedTime);

    const result = await publishGeneratedTree({
      sourceDirectory: source,
      destinationDirectory: destination,
      preserve: [".gitkeep"],
    });

    assert.deepEqual(result, { changed: 1, unchanged: 1, removed: 1 });
    assert.equal(
      (await stat(resolve(destination, "assets/unchanged.js"))).mtimeMs,
      retainedTime.getTime(),
    );
    assert.equal(await readFile(resolve(destination, "assets/changed.js"), "utf8"), "new");
    await assert.rejects(stat(resolve(destination, "assets/stale.js")), { code: "ENOENT" });
    assert.equal(await readFile(resolve(destination, ".gitkeep"), "utf8"), "");
  });
});

test("rejects empty and symbolic-link source trees", async () => {
  await fixture(async ({ root, source, destination }) => {
    await assert.rejects(
      publishGeneratedTree({
        sourceDirectory: source,
        destinationDirectory: destination,
      }),
      /source has no files/,
    );

    await writeFile(resolve(root, "outside.js"), "outside");
    await symlink(resolve(root, "outside.js"), resolve(source, "linked.js"));
    await assert.rejects(
      publishGeneratedTree({
        sourceDirectory: source,
        destinationDirectory: destination,
      }),
      /cannot contain symbolic links/,
    );
  });
});

test("rejects nested source and destination paths", async () => {
  await fixture(async ({ source }) => {
    await writeFile(resolve(source, "app.js"), "content");
    await assert.rejects(
      publishGeneratedTree({
        sourceDirectory: source,
        destinationDirectory: resolve(source, "output"),
      }),
      /cannot contain one another/,
    );
  });
});
