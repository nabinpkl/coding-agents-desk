// Against a real filesystem, for the same reason `workspacePaths.test.ts` is: the atomic write, the
// binary refusal and the revision check are all behaviour at the syscall boundary.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileKind,
  isReadOnlyKind,
  listDirectory,
  readDocumentFile,
  readTextFile,
  revisionOf,
  writeTextFile,
} from "@/workspace/workspaceFiles";
import { WorkspaceFailure } from "@/workspace/workspacePaths";

const MAX = 1024 * 1024;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workspace-files-"));
  roots.push(root);
  return root;
}

async function refusal(run: () => Promise<unknown>): Promise<WorkspaceFailure> {
  try {
    await run();
  } catch (error) {
    if (error instanceof WorkspaceFailure) return error;
    throw error;
  }
  throw new Error("expected a WorkspaceFailure");
}

test("names a file's kind from its extension", () => {
  expect(fileKind("a/b/main.ts")).toBe("text");
  expect(fileKind("README.md")).toBe("markdown");
  expect(fileKind("notes.MARKDOWN")).toBe("markdown");
  expect(fileKind("page.htm")).toBe("html");
  expect(fileKind("analysis.ipynb")).toBe("notebook");
  expect(fileKind("report.docx")).toBe("docx");
  expect(fileKind("Justfile")).toBe("text");
  expect(fileKind("archive.tar/name")).toBe("text");
});

test("docx and notebooks are read-only, everything else is not", () => {
  expect(isReadOnlyKind("docx")).toBe(true);
  expect(isReadOnlyKind("notebook")).toBe(true);
  expect(isReadOnlyKind("markdown")).toBe(false);
  expect(isReadOnlyKind("html")).toBe(false);
  expect(isReadOnlyKind("text")).toBe(false);
});

test("lists directories first, then names in numeric order", async () => {
  const root = await workspace();
  await mkdir(join(root, "src"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "file10.ts"), "");
  await writeFile(join(root, "file2.ts"), "");

  const entries = await listDirectory(root, "");
  expect(entries.map((entry) => entry.name)).toEqual(["assets", "src", "file2.ts", "file10.ts"]);
  expect(entries[0]!.isDirectory).toBe(true);
  expect(entries[2]!.isDirectory).toBe(false);
});

test("a nested listing carries the path a client can ask for next", async () => {
  const root = await workspace();
  await mkdir(join(root, "src", "app"), { recursive: true });
  await writeFile(join(root, "src", "app", "main.tsx"), "");

  const entries = await listDirectory(root, "src/app");
  expect(entries).toEqual([{ name: "main.tsx", path: "src/app/main.tsx", isDirectory: false }]);
});

test("omits symlinks from a listing rather than offering what an open would refuse", async () => {
  const root = await workspace();
  await writeFile(join(root, "real.ts"), "");
  await symlink(join(root, "real.ts"), join(root, "link.ts"));

  expect((await listDirectory(root, "")).map((entry) => entry.name)).toEqual(["real.ts"]);
});

test("reads text and stamps it with the sha256 of its bytes", async () => {
  const root = await workspace();
  await writeFile(join(root, "main.ts"), "export {};\n");

  const file = await readTextFile(root, "main.ts", MAX);
  expect(file.text).toBe("export {};\n");
  expect(file.revision).toBe(revisionOf(new TextEncoder().encode("export {};\n")));
});

test("refuses a file with a NUL as binary, before blaming the decoder", async () => {
  const root = await workspace();
  await writeFile(join(root, "image.bin"), new Uint8Array([0x89, 0x50, 0x00, 0x4e]));

  expect((await refusal(() => readTextFile(root, "image.bin", MAX))).code).toBe("binary");
});

test("refuses invalid UTF-8 that carries no NUL", async () => {
  const root = await workspace();
  await writeFile(join(root, "broken.txt"), new Uint8Array([0xc3, 0x28]));

  expect((await refusal(() => readTextFile(root, "broken.txt", MAX))).code).toBe("invalidUtf8");
});

test("refuses a file over the cap without reading it", async () => {
  const root = await workspace();
  await writeFile(join(root, "big.txt"), "x".repeat(64));

  expect((await refusal(() => readTextFile(root, "big.txt", 8))).code).toBe("tooLarge");
});

test("reads a document as bytes, with the same revision the text path would give", async () => {
  const root = await workspace();
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]);
  await writeFile(join(root, "report.docx"), bytes);

  const document = await readDocumentFile(root, "report.docx", MAX);
  expect([...document.bytes]).toEqual([...bytes]);
  expect(document.revision).toBe(revisionOf(bytes));
});

test("writes when the revision still matches, and leaves no temporary behind", async () => {
  const root = await workspace();
  await writeFile(join(root, "main.ts"), "old\n");
  const before = await readTextFile(root, "main.ts", MAX);

  const outcome = await writeTextFile(root, "main.ts", before.revision, "new\n", MAX);
  expect(outcome.status).toBe("written");
  expect(await readFile(join(root, "main.ts"), "utf8")).toBe("new\n");
  expect(await readdir(root)).toEqual(["main.ts"]);
});

test("refuses a write whose base revision moved, and reports the one on disk", async () => {
  const root = await workspace();
  await writeFile(join(root, "main.ts"), "old\n");
  const stale = revisionOf(new TextEncoder().encode("something else\n"));

  const outcome = await writeTextFile(root, "main.ts", stale, "new\n", MAX);
  expect(outcome).toEqual({
    status: "conflict",
    currentRevision: revisionOf(new TextEncoder().encode("old\n")),
  });
  expect(await readFile(join(root, "main.ts"), "utf8")).toBe("old\n");
});

test("refuses to write a read-only kind", async () => {
  const root = await workspace();
  await writeFile(join(root, "report.docx"), "");

  expect((await refusal(() => writeTextFile(root, "report.docx", "any", "x", MAX))).code)
    .toBe("readOnly");
});

test("refuses a write that is too large, or carries a NUL, before touching the file", async () => {
  const root = await workspace();
  await writeFile(join(root, "main.ts"), "old\n");

  expect((await refusal(() => writeTextFile(root, "main.ts", "any", "x".repeat(16), 8))).code)
    .toBe("tooLarge");
  expect((await refusal(() => writeTextFile(root, "main.ts", "any", "a\0b", MAX))).code)
    .toBe("binary");
  expect(await readFile(join(root, "main.ts"), "utf8")).toBe("old\n");
});

test("refuses to write through a symlink", async () => {
  const root = await workspace();
  const outside = await workspace();
  await writeFile(join(outside, "target.ts"), "outside\n");
  await symlink(join(outside, "target.ts"), join(root, "link.ts"));

  expect((await refusal(() => writeTextFile(root, "link.ts", "any", "x", MAX))).code)
    .toBe("forbidden");
  expect(await readFile(join(outside, "target.ts"), "utf8")).toBe("outside\n");
});
