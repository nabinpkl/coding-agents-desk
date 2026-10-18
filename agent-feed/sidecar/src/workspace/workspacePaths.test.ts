// The security gate for the workspace IDE. Every refusal here is one the Swift made before the
// port (ADR-0115), tested against a real filesystem rather than a mock, because what is being
// pinned is behaviour at the syscall boundary and a fake would agree with whoever wrote it.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isStorablePath,
  MAXIMUM_PATH_BYTES,
  pathComponents,
  resolveDirectory,
  resolveFile,
  WorkspaceFailure,
} from "@/workspace/workspacePaths";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "workspace-paths-"));
  roots.push(root);
  return root;
}

function refusal(run: () => unknown): WorkspaceFailure {
  try {
    run();
  } catch (error) {
    if (error instanceof WorkspaceFailure) return error;
    throw error;
  }
  throw new Error("expected a WorkspaceFailure");
}

async function asyncRefusal(run: () => Promise<unknown>): Promise<WorkspaceFailure> {
  try {
    await run();
  } catch (error) {
    if (error instanceof WorkspaceFailure) return error;
    throw error;
  }
  throw new Error("expected a WorkspaceFailure");
}

test("splits an ordinary relative path", () => {
  expect(pathComponents("src/app/main.tsx", { allowRoot: false })).toEqual(["src", "app", "main.tsx"]);
});

test("the empty path is the root, and only where a root is allowed", () => {
  expect(pathComponents("", { allowRoot: true })).toEqual([]);
  expect(refusal(() => pathComponents("", { allowRoot: false })).code).toBe("invalidPath");
});

test("refuses an absolute path", () => {
  expect(refusal(() => pathComponents("/etc/passwd", { allowRoot: true })).code).toBe("invalidPath");
});

test("refuses traversal, in any position", () => {
  for (const path of ["..", "../etc", "src/../../etc", "src/..", "./src", "src/./app"]) {
    expect(refusal(() => pathComponents(path, { allowRoot: true })).code).toBe("invalidPath");
  }
});

test("refuses an empty component, so one file has one path", () => {
  expect(refusal(() => pathComponents("src//main.ts", { allowRoot: true })).code).toBe("invalidPath");
  expect(refusal(() => pathComponents("src/", { allowRoot: true })).code).toBe("invalidPath");
});

test("refuses an embedded NUL, which the syscall boundary would truncate at", () => {
  expect(refusal(() => pathComponents("src/main.ts\0.png", { allowRoot: true })).code).toBe("invalidPath");
});

test("refuses a path longer than the state store will hold", () => {
  const long = "a".repeat(MAXIMUM_PATH_BYTES + 1);
  expect(refusal(() => pathComponents(long, { allowRoot: true })).code).toBe("invalidPath");
});

test("isStorablePath answers the same rules without throwing", () => {
  expect(isStorablePath("src/main.ts")).toBe(true);
  expect(isStorablePath("")).toBe(false);
  expect(isStorablePath("../escape")).toBe(false);
});

test("resolves a real file inside the root", async () => {
  const root = await workspace();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "export {};\n");

  const resolved = await resolveFile(root, "src/main.ts");
  expect(resolved.name).toBe("main.ts");
  expect(resolved.directory).toBe(join(root, "src"));
  expect(resolved.absolute).toBe(join(root, "src", "main.ts"));
});

test("refuses a symlinked leaf even when its target is inside the root", async () => {
  const root = await workspace();
  await writeFile(join(root, "real.ts"), "export {};\n");
  await symlink(join(root, "real.ts"), join(root, "link.ts"));

  expect((await asyncRefusal(() => resolveFile(root, "link.ts"))).code).toBe("forbidden");
});

test("refuses a symlinked directory component, which is the escape that matters", async () => {
  const root = await workspace();
  const outside = await workspace();
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(outside, join(root, "escape"));

  expect((await asyncRefusal(() => resolveFile(root, "escape/secret.txt"))).code).toBe("forbidden");
  expect((await asyncRefusal(() => resolveDirectory(root, "escape"))).code).toBe("forbidden");
});

test("a missing file is notFound, a missing directory component is notFound", async () => {
  const root = await workspace();
  expect((await asyncRefusal(() => resolveFile(root, "absent.ts"))).code).toBe("notFound");
  expect((await asyncRefusal(() => resolveFile(root, "nowhere/absent.ts"))).code).toBe("notFound");
});

test("a directory asked for as a file is notFile, and the reverse is notDirectory", async () => {
  const root = await workspace();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "file.ts"), "export {};\n");

  expect((await asyncRefusal(() => resolveFile(root, "src"))).code).toBe("notFile");
  expect((await asyncRefusal(() => resolveDirectory(root, "file.ts"))).code).toBe("notDirectory");
});

test("resolves the root itself as a directory", async () => {
  const root = await workspace();
  expect(await resolveDirectory(root, "")).toBe(root);
});
