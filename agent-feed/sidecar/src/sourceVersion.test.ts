import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceVersion } from "@/sourceVersion";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** An `agent-feed` directory holding one sidecar file and one wire file. */
async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "source-version-"));
  roots.push(root);
  await mkdir(join(root, "sidecar", "src", "http"), { recursive: true });
  await mkdir(join(root, "wire"), { recursive: true });
  await writeFile(join(root, "sidecar", "src", "http", "routes.ts"), "export const a = 1;\n");
  await writeFile(join(root, "wire", "bot.ts"), "export type B = string;\n");
  return root;
}

test("two copies of one tree agree, wherever they sit", async () => {
  expect(sourceVersion(await tree())).toBe(sourceVersion(await tree()));
});

test("moves with the sidecar's source and the wire, and not with tests or other files", async () => {
  const root = await tree();
  const before = sourceVersion(root);

  await writeFile(join(root, "sidecar", "src", "http", "routes.test.ts"), "test\n");
  await writeFile(join(root, "sidecar", "README.md"), "notes\n");
  expect(sourceVersion(root)).toBe(before);

  await writeFile(join(root, "wire", "bot.ts"), "export type B = number;\n");
  const afterWire = sourceVersion(root);
  expect(afterWire).not.toBe(before);

  await writeFile(join(root, "sidecar", "src", "http", "more.ts"), "export {};\n");
  expect(sourceVersion(root)).not.toBe(afterWire);
});
