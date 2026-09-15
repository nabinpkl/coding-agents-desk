// The history routes against a real service over a real temporary repository, for the reason the
// roster route tests give: what is being pinned is the boundary, which refusal a client sees and
// with which status.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceCommit, WorkspaceCommitDetail, WorkspaceCommitDiff } from "@agentdesk/agent-feed-wire";
import type { RouteHandler } from "@/http/route";
import { createWorkspaceHistoryRoutes } from "@/http/workspace-routes/workspaceHistoryRoutes";
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

async function run(root: string, args: string[]): Promise<void> {
  await Bun.spawn(["git", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited;
}

async function harness(): Promise<{ routes: RouteHandler; workspaceId: string }> {
  const state = await scratch("workspace-history-routes-state-");
  const root = await scratch("workspace-history-routes-project-");
  for (const args of [
    ["init", "--initial-branch=main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
  ]) await run(root, args);
  await writeFile(join(root, "main.ts"), "export {};\n");
  await run(root, ["add", "."]);
  await run(root, ["commit", "-m", "first"]);
  await writeFile(join(root, "main.ts"), "export {};\nexport const x = 1;\n");
  await run(root, ["commit", "-am", "second"]);

  const service = new WorkspaceService(
    new WorkspaceStore(join(state, "workspaces.json")),
    new WorkspaceSharedStateStore(join(state, "state.json")),
  );
  services.push(service);
  await service.ready();
  const workspace = await service.store.add(root, "Project");
  return { routes: createWorkspaceHistoryRoutes(service), workspaceId: workspace.id };
}

function call(routes: RouteHandler, path: string): Promise<Response | undefined> {
  const url = new URL(`http://127.0.0.1${path}`);
  return Promise.resolve(routes(new Request(url.toString()), url, server));
}

async function json<T>(response: Response | undefined): Promise<T> {
  expect(response).toBeDefined();
  return await response!.json() as T;
}

test("answers the log, one commit's files, and one file's patch", async () => {
  const { routes, workspaceId } = await harness();

  const log = await json<{ commits: WorkspaceCommit[] }>(
    await call(routes, `/api/workspace/${workspaceId}/commits`),
  );
  expect(log.commits.map((commit) => commit.subject)).toEqual(["second", "first"]);

  const hash = log.commits[0]!.hash;
  const detail = await json<{ detail: WorkspaceCommitDetail }>(
    await call(routes, `/api/workspace/${workspaceId}/commit?hash=${hash}`),
  );
  expect(detail.detail.files.map((file) => file.path)).toEqual(["main.ts"]);

  const diff = await json<{ diff: WorkspaceCommitDiff }>(
    await call(routes, `/api/workspace/${workspaceId}/diff?hash=${hash}&path=main.ts`),
  );
  expect(diff.diff.patch).toContain("+export const x = 1;");
  expect(diff.diff.truncated).toBe(false);
});

test("takes a limit, and refuses one that is not a count", async () => {
  const { routes, workspaceId } = await harness();
  const one = await json<{ commits: WorkspaceCommit[] }>(
    await call(routes, `/api/workspace/${workspaceId}/commits?limit=1`),
  );
  expect(one.commits).toHaveLength(1);

  const refused = await call(routes, `/api/workspace/${workspaceId}/commits?limit=nonsense`);
  expect(refused?.status).toBe(400);
});

test("refuses a hash that is not one, rather than handing it to git", async () => {
  const { routes, workspaceId } = await harness();
  // A leading dash is the case that matters: an argument list is not a shell, so this cannot
  // inject a command, but it can still be read by git as an option rather than as a commit.
  const response = await call(routes, `/api/workspace/${workspaceId}/commit?hash=--help`);
  expect(response?.status).toBe(400);
  expect((await json<{ error: { code: string } }>(response)).error.code).toBe("invalidPath");
});

test("declines a path it does not own, so the roster routes still get a look", async () => {
  const { routes, workspaceId } = await harness();
  expect(await call(routes, `/api/workspace/${workspaceId}/tree`)).toBeUndefined();
});

test("answers 404 for a workspace the sidecar does not know", async () => {
  const { routes } = await harness();
  const response = await call(routes, "/api/workspace/nope/commits");
  expect(response?.status).toBe(404);
});
