// The link check has to catch the edit landing in the wrong order, and must not hold a tree that
// would start fine: a false alarm here stops the sidecar picking up every change after it.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredPackages, linkFailure } from "@/supervisorLinks";

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

// In a plain `bun` process, which is how the supervisor runs it. Inside `bun test` the bundler
// cannot resolve this tree's `@/http/*` imports (measured on 1.3.13: every one of them, and no
// other `@/` path), so asked in-process this test would report a failure the supervisor never sees.
test("the sidecar as it stands links", async () => {
  const sidecar = join(import.meta.dir, "..");
  const script = `import { declaredPackages, linkFailure } from ${JSON.stringify(join(import.meta.dir, "supervisorLinks.ts"))};
console.log(JSON.stringify(await linkFailure(${JSON.stringify(join(sidecar, "src/server.ts"))}, declaredPackages(${JSON.stringify(sidecar)}))));`;
  const run = Bun.spawn({ cmd: [process.execPath, "-e", script], stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(run.stdout).text(), await new Response(run.stderr).text()];
  expect(await run.exited, err).toBe(0);
  expect(JSON.parse(out)).toBeNull();
});
