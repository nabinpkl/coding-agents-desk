// The semantics ported from `WorkspaceIDEStateCoordinator`: what a revision means, what makes a
// retry safe, and which operations are refused rather than absorbed.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceSharedState } from "@agentdesk/agent-feed-wire";
import { MAXIMUM_OPEN_PATHS, SharedStateFailure, WorkspaceSharedStateStore } from "@/workspace/workspaceSharedState";

const WORKSPACE = "workspace-1";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function store(): Promise<{ store: WorkspaceSharedStateStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "workspace-state-"));
  directories.push(directory);
  const path = join(directory, "state.json");
  const created = new WorkspaceSharedStateStore(path);
  await created.ready;
  return { store: created, path };
}

let operations = 0;
function nextOperationId(): string {
  operations += 1;
  return `operation-${operations}`;
}

async function open(created: WorkspaceSharedStateStore, path: string): Promise<WorkspaceSharedState> {
  return created.apply(WORKSPACE, created.snapshot(WORKSPACE).revision, nextOperationId(), {
    type: "open",
    path,
  });
}

test("an unknown workspace starts empty at revision zero", async () => {
  const { store: created } = await store();
  expect(created.snapshot(WORKSPACE)).toEqual({
    workspaceId: WORKSPACE,
    revision: 0,
    orderedOpenPaths: [],
    expandedDirectoryPaths: [],
    previewPath: null,
  });
});

test("opening a file advances the revision and appends it", async () => {
  const { store: created } = await store();
  const state = await open(created, "src/main.ts");
  expect(state.revision).toBe(1);
  expect(state.orderedOpenPaths).toEqual(["src/main.ts"]);
});

test("opening an already-open file changes nothing and does not advance the revision", async () => {
  const { store: created } = await store();
  await open(created, "src/main.ts");
  const again = await open(created, "src/main.ts");
  expect(again.revision).toBe(1);
  expect(again.orderedOpenPaths).toEqual(["src/main.ts"]);
});

test("a replayed operation id is a no-op, which is what makes a retry safe", async () => {
  const { store: created } = await store();
  const id = nextOperationId();
  const first = await created.apply(WORKSPACE, 0, id, { type: "open", path: "a.ts" });
  const replay = await created.apply(WORKSPACE, 0, id, { type: "open", path: "a.ts" });
  expect(first).toEqual(replay);
  expect(replay.orderedOpenPaths).toEqual(["a.ts"]);
});

test("a stale base revision conflicts and reports the revision on disk", async () => {
  const { store: created } = await store();
  await open(created, "a.ts");

  const failure = await created.apply(WORKSPACE, 0, nextOperationId(), { type: "open", path: "b.ts" }).then(
    () => null,
    (error: unknown) => error as SharedStateFailure,
  );
  expect(failure).toBeInstanceOf(SharedStateFailure);
  expect(failure!.code).toBe("revisionConflict");
  expect(failure!.currentRevision).toBe(1);
  expect(created.snapshot(WORKSPACE).orderedOpenPaths).toEqual(["a.ts"]);
});

test("closing removes, and closing what is not open changes nothing", async () => {
  const { store: created } = await store();
  await open(created, "a.ts");
  const closed = await created.apply(WORKSPACE, 1, nextOperationId(), {
    type: "close",
    path: "a.ts",
  });
  expect(closed.orderedOpenPaths).toEqual([]);
  expect(closed.revision).toBe(2);

  const again = await created.apply(WORKSPACE, 2, nextOperationId(), {
    type: "close",
    path: "a.ts",
  });
  expect(again.revision).toBe(2);
});

test("a reorder must be a permutation of what is open", async () => {
  const { store: created } = await store();
  await open(created, "a.ts");
  await open(created, "b.ts");

  const reordered = await created.apply(WORKSPACE, 2, nextOperationId(), {
    type: "reorder",
    orderedPaths: ["b.ts", "a.ts"],
  });
  expect(reordered.orderedOpenPaths).toEqual(["b.ts", "a.ts"]);

  for (const orderedPaths of [["a.ts"], ["a.ts", "a.ts"], ["a.ts", "b.ts", "c.ts"]]) {
    await expect(created.apply(WORKSPACE, 3, nextOperationId(), { type: "reorder", orderedPaths })).rejects.toThrow(
      SharedStateFailure,
    );
  }
});

test("expand and collapse track directories independently of open files", async () => {
  const { store: created } = await store();
  const expanded = await created.apply(WORKSPACE, 0, nextOperationId(), {
    type: "expand",
    path: "src",
  });
  expect(expanded.expandedDirectoryPaths).toEqual(["src"]);
  expect(expanded.orderedOpenPaths).toEqual([]);

  const collapsed = await created.apply(WORKSPACE, 1, nextOperationId(), {
    type: "collapse",
    path: "src",
  });
  expect(collapsed.expandedDirectoryPaths).toEqual([]);
});

test("refuses a path the file layer would refuse, before it can be stored", async () => {
  const { store: created } = await store();
  for (const path of ["", "/etc/passwd", "../escape", "a//b", "a\0b"]) {
    await expect(created.apply(WORKSPACE, 0, nextOperationId(), { type: "open", path })).rejects.toThrow(
      SharedStateFailure,
    );
  }
});

test("refuses an empty operation id", async () => {
  const { store: created } = await store();
  await expect(created.apply(WORKSPACE, 0, "", { type: "open", path: "a.ts" })).rejects.toThrow(SharedStateFailure);
});

test("refuses to open past the cap", async () => {
  const { store: created } = await store();
  for (let index = 0; index < MAXIMUM_OPEN_PATHS; index += 1) {
    await open(created, `file-${index}.ts`);
  }
  await expect(open(created, "one-too-many.ts")).rejects.toThrow(SharedStateFailure);
});

test("tells subscribers only when something changed", async () => {
  const { store: created } = await store();
  const seen: number[] = [];
  const stop = created.subscribe((state) => seen.push(state.revision));

  await open(created, "a.ts");
  await open(created, "a.ts");
  await open(created, "b.ts");
  stop();
  await open(created, "c.ts");

  expect(seen).toEqual([1, 2]);
});

test("concurrent operations serialise instead of losing one", async () => {
  const { store: created } = await store();
  // Both start from revision 0, which is exactly the race: without serialisation both would read 0,
  // both would write 1, and one open would vanish with no error anywhere. Serialised, the second
  // sees revision 1 and conflicts, which is an outcome a client can act on.
  const outcomes = await Promise.allSettled([
    created.apply(WORKSPACE, 0, nextOperationId(), { type: "open", path: "a.ts" }),
    created.apply(WORKSPACE, 0, nextOperationId(), { type: "open", path: "b.ts" }),
  ]);
  expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
  expect(created.snapshot(WORKSPACE).orderedOpenPaths).toEqual(["a.ts"]);
});

test("survives a reload", async () => {
  const { store: created, path } = await store();
  await open(created, "src/main.ts");

  const reopened = new WorkspaceSharedStateStore(path);
  await reopened.ready;
  expect(reopened.snapshot(WORKSPACE).orderedOpenPaths).toEqual(["src/main.ts"]);
  expect(reopened.snapshot(WORKSPACE).revision).toBe(1);
});

test("refuses a state file written by something else", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workspace-state-"));
  directories.push(directory);
  const path = join(directory, "state.json");
  await writeFile(path, JSON.stringify({ version: 99, records: {} }));

  await expect(new WorkspaceSharedStateStore(path).ready).rejects.toThrow();
});

async function preview(created: WorkspaceSharedStateStore, path: string): Promise<WorkspaceSharedState> {
  return created.apply(WORKSPACE, created.snapshot(WORKSPACE).revision, nextOperationId(), {
    type: "preview",
    path,
  });
}

test("a preview replaces the previous preview in place, so stepping through results leaves one tab", async () => {
  const { store: created } = await store();
  await open(created, "kept.ts");
  await preview(created, "first.ts");
  await open(created, "after.ts");
  const second = await preview(created, "second.ts");
  expect(second.orderedOpenPaths).toEqual(["kept.ts", "second.ts", "after.ts"]);
  expect(second.previewPath).toBe("second.ts");
});

test("opening the preview keeps it, and the next preview becomes a tab of its own", async () => {
  const { store: created } = await store();
  await preview(created, "first.ts");
  const kept = await open(created, "first.ts");
  expect(kept.previewPath).toBeNull();
  expect(kept.revision).toBe(2);
  const next = await preview(created, "second.ts");
  expect(next.orderedOpenPaths).toEqual(["first.ts", "second.ts"]);
});

test("previewing a file that is already a tab changes nothing", async () => {
  const { store: created } = await store();
  await open(created, "a.ts");
  const again = await preview(created, "a.ts");
  expect(again.revision).toBe(1);
  expect(again.previewPath).toBeNull();
});

test("closing the preview clears the slot", async () => {
  const { store: created } = await store();
  await preview(created, "a.ts");
  const closed = await created.apply(WORKSPACE, 1, nextOperationId(), { type: "close", path: "a.ts" });
  expect(closed).toMatchObject({ orderedOpenPaths: [], previewPath: null });
});

test("a record stored before previews existed loads with no preview", async () => {
  const { path } = await store();
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      records: {
        [WORKSPACE]: { revision: 3, orderedOpenPaths: ["a.ts"], expandedDirectoryPaths: [], appliedOperationIds: [] },
      },
    }),
  );
  const reloaded = new WorkspaceSharedStateStore(path);
  await reloaded.ready;
  expect(reloaded.snapshot(WORKSPACE)).toMatchObject({ orderedOpenPaths: ["a.ts"], previewPath: null });
});
