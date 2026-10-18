// The graph walk, against a real tree. What it has to get right is completeness: a file it misses
// is a file the supervisor goes on running the old copy of, with nothing on screen to say so.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownSources } from "@/supervisor/supervisorSources";

/** Removed by the name this run was handed, never a glob and never a parent. */
const made: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "own-sources-"));
  made.push(root);
  for (const [name, source] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, source);
  }
  return root;
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

test("follows local imports as far as they go", () => {
  const root = tree({
    "supervisor.ts": 'import { a } from "@/gate";\nimport chokidar from "chokidar";\n',
    "gate.ts": 'import { b } from "@/registry";\nexport const a = b;\n',
    "registry.ts": "export const b = 1;\n",
    // Watched by this process, but not part of it: replacing the child is what covers this one.
    "server.ts": 'import { a } from "@/gate";\n',
  });
  const own = ownSources(join(root, "supervisor.ts"), root);
  expect([...own].map((file) => file.slice(root.length + 1)).sort()).toEqual([
    "gate.ts",
    "registry.ts",
    "supervisor.ts",
  ]);
});

test("stops rather than looping when two files import each other", () => {
  const root = tree({
    "supervisor.ts": 'import "@/gate";\n',
    "gate.ts": 'import "@/supervisor";\n',
  });
  expect(ownSources(join(root, "supervisor.ts"), root).size).toBe(2);
});

test("ignores packages, which it could not replace itself over anyway", () => {
  const root = tree({
    "supervisor.ts": 'import chokidar from "chokidar";\nimport { x } from "@agentdesk/agent-feed-wire";\n',
  });
  expect(ownSources(join(root, "supervisor.ts"), root).size).toBe(1);
});

test("finds a .tsx module too, since the alias carries no extension", () => {
  const root = tree({
    "supervisor.ts": 'import "@/view";\n',
    "view.tsx": "export const View = 1;\n",
  });
  expect([...ownSources(join(root, "supervisor.ts"), root)]).toContain(join(root, "view.tsx"));
});

// Both at startup, where refusing to start would be the worse bargain: a supervisor that watches a
// slightly smaller set still supervises, and the watcher comes back when the file is whole.
test("an import that resolves to nothing is skipped rather than thrown over", () => {
  const root = tree({ "supervisor.ts": 'import "@/gone";\n' });
  expect(ownSources(join(root, "supervisor.ts"), root).size).toBe(1);
});

test("a file caught half-written contributes what it can", () => {
  const root = tree({
    "supervisor.ts": 'import "@/gate";\n',
    "gate.ts": "export const a = {\n",
  });
  const own = ownSources(join(root, "supervisor.ts"), root);
  expect(own.has(join(root, "gate.ts"))).toBe(true);
});
