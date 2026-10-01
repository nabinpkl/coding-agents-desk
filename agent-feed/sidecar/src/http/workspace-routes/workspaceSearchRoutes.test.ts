// The search routes against a real service, pinning what a client sees: the answers, and which
// refusal arrives with which status.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceError, WorkspaceFileList, WorkspaceSearchResult } from "@agentdesk/agent-feed-wire";
import { ripgrepBinary } from "@/config/configBinaries";
import type { RouteHandler } from "@/http/route";
import { createWorkspaceSearchRoutes, parseSearchOptions } from "@/http/workspace-routes/workspaceSearchRoutes";
import { RepositoryGitWatch } from "@/workspace/repositoryWatch";
import { WorkspaceSharedStateStore } from "@/workspace/workspaceSharedState";
import { WorkspaceService } from "@/workspace/workspaceService";
import { WorkspaceStore } from "@/workspace/workspaceStore";

const rg = ripgrepBinary();
const server = { timeout() {} } as never;
const directories: string[] = [];
const services: WorkspaceService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness(ripgrepPath: string | null): Promise<{ routes: RouteHandler; workspaceId: string }> {
  const state = await mkdtemp(join(tmpdir(), "workspace-search-routes-state-"));
  const root = await mkdtemp(join(tmpdir(), "workspace-search-routes-project-"));
  directories.push(state, root);
  await writeFile(join(root, "main.ts"), "const alder = 1;\n");
  const service = new WorkspaceService(
    new WorkspaceStore(join(state, "workspaces.json")),
    new WorkspaceSharedStateStore(join(state, "state.json")),
    new RepositoryGitWatch(),
  );
  services.push(service);
  await service.ready();
  const workspace = await service.store.add(root, "Project");
  return { routes: createWorkspaceSearchRoutes(service, ripgrepPath), workspaceId: workspace.id };
}

async function call(routes: RouteHandler, path: string): Promise<Response> {
  const url = new URL(`http://127.0.0.1${path}`);
  const response = await Promise.resolve(routes(new Request(url.toString()), url, server));
  expect(response).toBeDefined();
  return response!;
}

test.skipIf(!rg)("answers the file list and the matching lines", async () => {
  const { routes, workspaceId } = await harness(rg);
  const list = await (await call(routes, `/api/workspaces/${workspaceId}/files`)).json() as WorkspaceFileList;
  expect(list).toEqual({ workspaceId, files: ["main.ts"], truncated: false });

  const found = await (await call(routes, `/api/workspaces/${workspaceId}/search?q=alder`))
    .json() as WorkspaceSearchResult;
  expect(found.matchCount).toBe(1);
  expect(found.files[0]).toEqual({
    path: "main.ts",
    matches: [{ line: 1, preview: "const alder = 1;", ranges: [[6, 11]], previewOffset: 0 }],
  });
});

test.skipIf(!rg)("a regex rg refuses is a 400 carrying its reason", async () => {
  const { routes, workspaceId } = await harness(rg);
  const response = await call(routes, `/api/workspaces/${workspaceId}/search?q=(&regex=1`);
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: WorkspaceError }).error.code).toBe("invalidQuery");
});

test("no rg on the machine is a 503 that says so, for both searches", async () => {
  const { routes, workspaceId } = await harness(null);
  for (const path of ["files", "search?q=x"]) {
    const response = await call(routes, `/api/workspaces/${workspaceId}/${path}`);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: WorkspaceError }).error.message).toContain("not installed");
  }
});

test("an unknown workspace is unavailable, and other actions fall through", async () => {
  const { routes } = await harness(rg);
  expect((await call(routes, "/api/workspaces/nope/files")).status).toBe(404);
  const url = new URL("http://127.0.0.1/api/workspaces/nope/tree");
  expect(routes(new Request(url.toString()), url, server)).toBeUndefined();
});

test("options read as flags and comma-separated globs", () => {
  expect(parseSearchOptions(new URLSearchParams("case=1&regex=1&include=*.ts, src/**&exclude=")))
    .toEqual({ matchCase: true, wholeWord: false, regex: true, include: ["*.ts", "src/**"], exclude: [] });
});
