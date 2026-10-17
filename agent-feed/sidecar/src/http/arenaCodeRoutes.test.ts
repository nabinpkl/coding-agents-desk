import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArenaRunSummary } from "@agentdesk/agent-feed-wire";
import type { ArenaService } from "@/arena/arenaService";
import { createArenaCodeRoutes } from "@/http/arenaCodeRoutes";
import { RepositoryGitWatch } from "@/workspace/repositoryWatch";

const server = { timeout() {} } as never;
const repositories = new RepositoryGitWatch({ quietMs: 50, longestWaitMs: 200 });
const LIMITS = { maxTextBytes: 1024, maxDocumentBytes: 1024 };
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** An arena home holding one run, `arena-run-1`, whose contestant `c1` has a worktree. */
async function arena() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "arena-code-route-")));
  roots.push(home);
  const folder = join(home, "arena-run-1");
  const worktree = join(folder, "c1");
  await mkdir(join(worktree, "src"), { recursive: true });
  await writeFile(join(worktree, "src", "answer.ts"), "export const answer = 42;\n");
  await mkdir(join(folder, "judge"));
  await writeFile(join(home, "secret.txt"), "beside the runs\n");
  const run = {
    runId: RUN_ID,
    name: "arena run 1",
    folder,
    contestants: [{ contestantId: "c1", worktreePath: worktree }],
  } as unknown as ArenaRunSummary;
  const service = {
    newRunDefaults: () => ({ modes: ["terminals"], arenaHome: home, nextName: "arena run 2" }),
    listRuns: () => [run],
  } as unknown as ArenaService;
  const route = createArenaCodeRoutes(service, repositories, LIMITS);
  const ask = async (path: string) => {
    const request = new Request(`http://localhost/api/arena/code/${path}`);
    return (await route(request, new URL(request.url), server))!;
  };
  return { home, worktree, route, ask };
}

const names = async (response: Response) =>
  ((await response.json()) as { tree: { name: string }[] }).tree.map((node) => node.name);

test("no run is the arena home, a run is its folder, and a contestant is its worktree", async () => {
  const { ask } = await arena();
  expect(await names(await ask("tree"))).toEqual(["arena-run-1", "secret.txt"]);
  expect(await names(await ask(`tree?run=${RUN_ID}`))).toEqual(["c1", "judge"]);
  expect(await names(await ask(`tree?run=${RUN_ID}&contestant=c1`))).toEqual(["src"]);

  const file = await ask(`file?run=${RUN_ID}&contestant=c1&path=src/answer.ts`);
  expect(file.status).toBe(200);
  expect(await file.json()).toMatchObject({ path: "src/answer.ts", kind: "text", text: "export const answer = 42;\n" });
});

test("a run's folder reads nothing above it, and an unknown run or contestant is not found", async () => {
  const { ask } = await arena();
  const escape = await ask(`file?run=${RUN_ID}&path=../secret.txt`);
  expect([400, 403]).toContain(escape.status);

  const noRun = await ask("tree?run=22222222-2222-4222-8222-222222222222");
  expect(noRun.status).toBe(404);
  expect(((await noRun.json()) as { error: { code: string } }).error.code).toBe("arena-run-not-found");
  expect((await ask(`tree?run=${RUN_ID}&contestant=c9`)).status).toBe(404);
  expect((await ask(`file?run=${RUN_ID}&path=missing.ts`)).status).toBe(404);
  expect((await ask(`file?run=${RUN_ID}`)).status).toBe(400);
});

test("streams a worktree's git status and answers one change", async () => {
  const { worktree, ask } = await arena();
  await Bun.spawn(["git", "init", "--initial-branch=main"], { cwd: worktree, stdout: "ignore" }).exited;
  const stream = await ask(`git/stream?run=${RUN_ID}&contestant=c1`);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  expect(await nextEvent(stream, (event) => (event as { entries: unknown[] }).entries.length > 0)).toEqual({
    repository: true,
    branch: "main",
    entries: [{ relativePath: "src/answer.ts", indexStatus: "?", workTreeStatus: "?" }],
  });
  const diff = await ask(`git/diff?run=${RUN_ID}&contestant=c1&path=src/answer.ts`);
  expect(diff.status).toBe(200);
  expect(((await diff.json()) as { patch: string }).patch).toContain("+export const answer = 42;");
});

test("answers only the reads it has, and only to GET", async () => {
  const { route } = await arena();
  const other = new Request("http://localhost/api/arena/code/write");
  expect(route(other, new URL(other.url), server)).toBeUndefined();
  const post = new Request("http://localhost/api/arena/code/tree", { method: "POST" });
  expect((await route(post, new URL(post.url), server))?.status).toBe(405);
});

async function nextEvent(response: Response, accept: (event: unknown) => boolean) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("stream ended");
      buffered += decoder.decode(value);
      for (const frame of buffered.split("\n\n")) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (!data) continue;
        const event: unknown = JSON.parse(data.slice(6));
        if (accept(event)) return event;
      }
    }
  } finally {
    await reader.cancel();
  }
}
