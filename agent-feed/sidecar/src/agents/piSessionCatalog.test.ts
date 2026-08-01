import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPiSessionCandidate } from "./piSessionCatalog.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("bounded Pi discovery reads identity, canonical cwd, and first prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentdesk-pi-catalog-"));
  roots.push(root);
  const project = join(root, "project");
  await mkdir(project);
  const sessionsRoot = join(root, "sessions");
  const projectDir = join(sessionsRoot, `agentdesk-test-${Date.now()}`);
  await mkdir(projectDir, { recursive: true });
  roots.push(projectDir);
  const id = "019fbb18-69fd-7b4a-9924-394511ec7a16";
  const path = join(projectDir, `2026-08-01T00-00-00-000Z_${id}.jsonl`);
  await writeFile(path, [
    JSON.stringify({ type: "session", version: 3, id, cwd: project }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Build the thing" }] } }),
    "",
  ].join("\n"));
  const session = await readPiSessionCandidate(path, sessionsRoot);
  expect(session).toMatchObject({
    sessionId: id,
    source: "pi",
    project: await realpath(project),
    title: "Build the thing",
  });
});
