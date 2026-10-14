// The link check has to catch the edit landing in the wrong order, and must not hold a tree that
// would start fine: a false alarm here stops the sidecar picking up every change after it.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredPackages, linkFailure } from "@/supervisor/supervisorLinks";

const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

/** A project shaped like the sidecar: its own `@/` alias, and one npm dependency it declares. */
function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "supervisor-links-"));
  made.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "not-installed-anywhere": "1.0.0" } }));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "src", name), body);
  return root;
}

const callee = 'export const present = 1;\nexport interface OnlyAType { x: number }\n';

test("a tree whose imports all resolve links, declared packages included", async () => {
  const root = project({
    "b.ts": callee,
    "main.ts": 'import { present } from "@/b";\nimport type { OnlyAType } from "@/b";\nimport pkg from "not-installed-anywhere";\nconst t: OnlyAType = { x: present };\nconsole.log(t, pkg);\n',
  });
  expect(await linkFailure(join(root, "src/main.ts"), declaredPackages(root))).toBeNull();
});

test("a caller saved before its callee is named, with the file it is in", async () => {
  const root = project({
    "b.ts": callee,
    "main.ts": 'import { present, notYetWritten } from "@/b";\nconsole.log(present, notYetWritten);\n',
  });
  const failure = await linkFailure(join(root, "src/main.ts"), declaredPackages(root));
  expect(failure).toContain("main.ts:1");
  expect(failure).toContain("notYetWritten");
  // The callee by its name, not by a path relative to wherever the supervisor was started.
  expect(failure).toContain('"b.ts"');
  expect(failure).not.toContain("../");
});

test("an import of a module that does not exist is named", async () => {
  const root = project({ "main.ts": 'import { present } from "@/nowhere";\nconsole.log(present);\n' });
  expect(await linkFailure(join(root, "src/main.ts"), declaredPackages(root))).toContain("@/nowhere");
});

// Under `verbatimModuleSyntax` this is a type error, which `just check` reports. It runs, because
// the name is erased, so holding the sidecar on it would refuse a tree that starts.
test("a type imported without `type` is not held", async () => {
  const root = project({ "b.ts": callee, "main.ts": 'import { OnlyAType } from "@/b";\nconst t: OnlyAType = { x: 1 };\nconsole.log(t);\n' });
  expect(await linkFailure(join(root, "src/main.ts"), declaredPackages(root))).toBeNull();
});

test("the sidecar as it stands links", async () => {
  const sidecar = join(import.meta.dir, "../..");
  expect(await linkFailure(join(sidecar, "src/server.ts"), declaredPackages(sidecar))).toBeNull();
});

// The reason the check runs in a child at all: in-process, a build that never returned froze the
// supervisor whole. A child that never answers must cost a line on the panel row and nothing more.
test("a check that never answers is killed and reported, not waited on", async () => {
  const started = performance.now();
  const failure = await linkFailure("/nowhere/server.ts", [], { timeoutMs: 200, command: ["sleep", "30"] });
  expect(failure).toBe("could not check the import graph: no answer in 200ms");
  expect(performance.now() - started).toBeLessThan(5_000);
});
