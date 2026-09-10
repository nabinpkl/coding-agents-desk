// The routes against a real service over a real temporary workspace, because what is being pinned
// is the boundary: which refusal a client sees, and with which status.

import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteHandler } from "@/http/route";
import { createWorkspaceFileRoutes } from "@/http/workspace-routes/workspaceFileRoutes";
import { createWorkspaceRoutes } from "@/http/workspace-routes/workspaceRoutes";
import { WorkspaceSharedStateStore } from "@/workspace/workspaceSharedState";
import { WorkspaceService } from "@/workspace/workspaceService";
import { WorkspaceStore } from "@/workspace/workspaceStore";

const server = { timeout() {} } as never;
const directories: string[] = [];
const services: WorkspaceService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

interface Harness {
  roster: RouteHandler;
  files: RouteHandler;
  service: WorkspaceService;
  workspaceId: string;
  root: string;
}

async function harness(): Promise<Harness> {
  const state = await scratch("workspace-routes-state-");
  const root = await scratch("workspace-routes-project-");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "export {};\n");

  const service = new WorkspaceService(
    new WorkspaceStore(join(state, "workspaces.json")),
    new WorkspaceSharedStateStore(join(state, "state.json")),
  );
  services.push(service);
  await service.ready();
  const workspace = await service.store.add(root, "Project");
  return {
    roster: createWorkspaceRoutes(service),
    files: createWorkspaceFileRoutes(service, {
      maxTextBytes: 1024 * 1024,
      maxDocumentBytes: 1024 * 1024,
    }),
    service,
    workspaceId: workspace.id,
    root,
  };
}

/**
 * The parsed body, typed at the call site.
 *
 * A helper rather than `await response.json() as T` inline: split over two lines that reads as an
 * assignment followed by a stray `as`, which the transpiler refuses.
 */
async function json<T>(response: Response | undefined): Promise<T> {
  expect(response).toBeDefined();
  return await response!.json() as T;
}

function call(
  route: RouteHandler,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response | undefined> {
  const url = new URL(`http://127.0.0.1${path}`);
  const request = new Request(url.toString(), {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  return Promise.resolve(route(request, url, server));
}

test("lists the roster", async () => {
  const { roster, workspaceId } = await harness();
  const response = await call(roster, "GET", "/api/workspace/list");
  expect(response?.status).toBe(200);
  const body = await json<{ workspaces: { id: string; name: string }[] }>(response);
  expect(body.workspaces).toHaveLength(1);
  expect(body.workspaces[0]!.id).toBe(workspaceId);
  expect(body.workspaces[0]!.name).toBe("Project");
});

test("declines a path it does not own, so the next handler gets a look", async () => {
  const { roster, files } = await harness();
  expect(await call(roster, "GET", "/api/sessions")).toBeUndefined();
  expect(await call(files, "GET", "/api/workspace/list")).toBeUndefined();
});

test("an unknown workspace is 404 with a code the panel can render", async () => {
  const { roster } = await harness();
  const response = await call(roster, "GET", "/api/workspace/nope/tree");
  expect(response?.status).toBe(404);
  expect(await json<unknown>(response)).toEqual({
    error: {
      code: "workspaceUnavailable",
      message: "Workspace is unavailable.",
      workspaceId: "nope",
      path: null,
    },
  });
});

test("serves the tree, and expanding a directory changes it", async () => {
  const { roster, workspaceId } = await harness();
  const before = await json<{ tree: { name: string; children: unknown[] }[] }>(
    await call(roster, "GET", `/api/workspace/${workspaceId}/tree`),
  );
  expect(before.tree.map((node) => node.name)).toEqual(["src"]);
  expect(before.tree[0]!.children).toEqual([]);

  const applied = await call(roster, "POST", `/api/workspace/${workspaceId}/state`, {
    baseRevision: 0,
    operationId: "op-1",
    operation: { type: "expand", path: "src" },
  });
  expect(applied?.status).toBe(200);

  const after = await json<{ tree: { children: { name: string }[] }[] }>(
    await call(roster, "GET", `/api/workspace/${workspaceId}/tree`),
  );
  expect(after.tree[0]!.children.map((node) => node.name)).toEqual(["main.ts"]);
});

test("a stale base revision is 409", async () => {
  const { roster, workspaceId } = await harness();
  await call(roster, "POST", `/api/workspace/${workspaceId}/state`, {
    baseRevision: 0,
    operationId: "op-1",
    operation: { type: "open", path: "src/main.ts" },
  });
  const response = await call(roster, "POST", `/api/workspace/${workspaceId}/state`, {
    baseRevision: 0,
    operationId: "op-2",
    operation: { type: "open", path: "other.ts" },
  });
  expect(response?.status).toBe(409);
  expect((await json<{ error: { code: string } }>(response)).error.code).toBe("revisionConflict");
});

test("an unknown operation is 400 rather than being absorbed", async () => {
  const { roster, workspaceId } = await harness();
  for (const operation of [undefined, {}, { type: "detonate" }, { type: "open" }]) {
    const response = await call(roster, "POST", `/api/workspace/${workspaceId}/state`, {
      baseRevision: 0,
      operationId: "op",
      operation,
    });
    expect(response?.status).toBe(400);
  }
});

test("reads a file with its kind and revision", async () => {
  const { files, workspaceId } = await harness();
  const response = await call(files, "GET", `/api/workspace/${workspaceId}/file?path=src/main.ts`);
  expect(response?.status).toBe(200);
  const body = await json<{ file: { kind: string; text: string; revision: string } }>(response);
  expect(body.file.kind).toBe("text");
  expect(body.file.text).toBe("export {};\n");
  expect(body.file.revision).toMatch(/^[0-9a-f]{64}$/);
});

test("a symlink escape is 403 on read and on write", async () => {
  const { files, workspaceId, root } = await harness();
  const outside = await scratch("workspace-routes-outside-");
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(outside, join(root, "escape"));

  const read = await call(
    files,
    "GET",
    `/api/workspace/${workspaceId}/file?path=escape/secret.txt`,
  );
  expect(read?.status).toBe(403);

  const write = await call(files, "POST", `/api/workspace/${workspaceId}/file`, {
    path: "escape/secret.txt",
    expectedRevision: "any",
    text: "overwritten",
  });
  expect(write?.status).toBe(403);
  expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("secret\n");
});

test("an absolute path or a traversal is 400, and never reaches the filesystem", async () => {
  const { files, workspaceId } = await harness();
  for (const path of ["/etc/passwd", "../../etc/passwd", "src/../../etc/passwd"]) {
    const response = await call(
      files,
      "GET",
      `/api/workspace/${workspaceId}/file?path=${encodeURIComponent(path)}`,
    );
    expect(response?.status).toBe(400);
  }
});

test("writes when the revision matches, and 409s when it does not", async () => {
  const { files, workspaceId, root } = await harness();
  const read = await json<{ file: { revision: string } }>(
    await call(files, "GET", `/api/workspace/${workspaceId}/file?path=src/main.ts`),
  );

  const written = await call(files, "POST", `/api/workspace/${workspaceId}/file`, {
    path: "src/main.ts",
    expectedRevision: read.file.revision,
    text: "export const x = 1;\n",
  });
  expect(written?.status).toBe(200);
  expect(await readFile(join(root, "src", "main.ts"), "utf8")).toBe("export const x = 1;\n");

  const stale = await call(files, "POST", `/api/workspace/${workspaceId}/file`, {
    path: "src/main.ts",
    expectedRevision: read.file.revision,
    text: "export const y = 2;\n",
  });
  expect(stale?.status).toBe(409);
  const conflict = await json<{ conflict: { currentRevision: string } }>(stale);
  expect(conflict.conflict.currentRevision).toMatch(/^[0-9a-f]{64}$/);
});

test("refuses a body that is not a JSON object", async () => {
  const { roster } = await harness();
  const url = new URL("http://127.0.0.1/api/workspace/add");
  const response = await Promise.resolve(roster(
    new Request(url.toString(), { method: "POST", body: "not json" }),
    url,
    server,
  ));
  expect(response?.status).toBe(400);
});

test("adds, renames, reorders and removes through the roster routes", async () => {
  const { roster } = await harness();
  const second = await scratch("workspace-routes-second-");
  const added = await call(roster, "POST", "/api/workspace/add", { root: second, name: "Second" });
  expect(added?.status).toBe(200);
  const { workspace } = await json<{ workspace: { id: string } }>(added);

  expect((await call(roster, "POST", "/api/workspace/rename", {
    id: workspace.id,
    name: "Renamed",
  }))?.status).toBe(204);

  const listed = await json<{ workspaces: { id: string; name: string }[] }>(
    await call(roster, "GET", "/api/workspace/list"),
  );
  expect(listed.workspaces.map((entry) => entry.name)).toEqual(["Project", "Renamed"]);

  const ids = listed.workspaces.map((entry) => entry.id).reverse();
  expect((await call(roster, "POST", "/api/workspace/reorder", { ids }))?.status).toBe(204);

  expect((await call(roster, "POST", "/api/workspace/remove", { id: workspace.id }))?.status)
    .toBe(204);
});

test("refuses a reorder that is not a permutation", async () => {
  const { roster, workspaceId } = await harness();
  const response = await call(roster, "POST", "/api/workspace/reorder", {
    ids: [workspaceId, "invented"],
  });
  expect(response?.status).toBe(400);
});
