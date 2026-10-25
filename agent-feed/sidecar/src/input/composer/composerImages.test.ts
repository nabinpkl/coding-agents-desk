import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { imageMediaType, writeComposerImage } from "@/input/composer/composerImages";
import { until } from "@/testing/until";

/** A file's first bytes, which is all the sniff ever looks at. */
function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46);
const GIF = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20);

async function store() {
  return { directory: await mkdtemp("/tmp/agentdesk-composer-images-"), now: Date.now };
}

test("identifies each kind a composer takes by its magic number", () => {
  expect(imageMediaType(PNG)).toBe("image/png");
  expect(imageMediaType(JPEG)).toBe("image/jpeg");
  expect(imageMediaType(GIF)).toBe("image/gif");
  expect(imageMediaType(WEBP)).toBe("image/webp");
});

test("refuses everything else, including images Claude's own name test would reject", () => {
  // A BMP is a real image and the CLI will even convert one it finds on the clipboard, but its
  // path test has no `.bmp` in it -- so a file written with that extension reaches the composer
  // as a literal path. Refusing here is the only place that can be said usefully.
  expect(imageMediaType(bytes(0x42, 0x4d, 0x36, 0, 0, 0))).toBeNull();
  expect(imageMediaType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  expect(imageMediaType(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45))).toBeNull();
  expect(imageMediaType(bytes())).toBeNull();
  expect(imageMediaType(bytes(0x89, 0x50))).toBeNull();
});

test("writes an absolute path whose extension is one Claude's paste handler accepts", async () => {
  // Both halves are load-bearing and both were measured on a live pane: a relative path is
  // inserted as text, and so is a path whose extension is not in that set.
  const where = await store();
  const path = await writeComposerImage(PNG, "image/png", where);
  expect(path.startsWith("/")).toBe(true);
  expect(/\.(png|jpe?g|gif|webp)$/i.test(path)).toBe(true);
  expect([...(await readFile(path))]).toEqual([...PNG]);
});

test("names the file itself, so nothing a page sent becomes part of a path", async () => {
  const where = await store();
  const first = await writeComposerImage(JPEG, "image/jpeg", where);
  const second = await writeComposerImage(JPEG, "image/jpeg", where);
  expect(first).not.toBe(second);
  expect(first.endsWith(".jpg")).toBe(true);
});

test("sweeps images old enough that nothing is still looking at them", async () => {
  // The bytes are read within a moment of the paste and Claude keeps its own copy, so what the
  // file is still there for a day later is nothing at all.
  const where = await store();
  const stale = join(where.directory, "stale.png");
  await writeFile(stale, PNG);
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(stale, old, old);

  const kept = await writeComposerImage(PNG, "image/png", where);
  // The sweep is not awaited by the write -- it is tidying, not the request -- so wait for its result.
  const keptName = kept.split("/").at(-1)!;
  await until(async () => (await readdir(where.directory)).length === 1, "the sweep to remove the stale image");
  expect(await readdir(where.directory)).toEqual([keptName]);
});

test("refuses a directory whose name would break the paste it ends up inside", async () => {
  // A path carrying a newline reads as several candidates, and most of it would be inserted into
  // somebody's composer as text. Said here rather than discovered there.
  const where = { directory: "/tmp/agentdesk\nimages", now: Date.now };
  expect(writeComposerImage(PNG, "image/png", where)).rejects.toThrow(/newline/);
});
