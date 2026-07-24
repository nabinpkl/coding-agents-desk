import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireIndex,
  discardIndexIfUnused,
  ensureIndexed,
  getEventCount,
  readEventRaw,
  readEvents,
  releaseIndex,
} from "./eventIndex.ts";
import { state } from "./transcriptState.ts";
import { sessionKey } from "./transcriptCatalog.ts";

const roots: string[] = [];
const source = "codex" as const;
const sessionId = "11111111-1111-1111-1111-111111111111";

afterEach(async () => {
  state.sessions.clear();
  state.eventByteOffsets.clear();
  state.indexedSizes.clear();
  state.indexed.clear();
  state.indexBuilds.clear();
  state.indexReferences.clear();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("builds an index only while acquired and releases it after the final owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-index-"));
  roots.push(root);
  const transcriptPath = join(root, "rollout.jsonl");
  await writeFile(transcriptPath, [
    JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "event_msg", payload: { type: "task_started" } }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", type: "event_msg", payload: { type: "task_complete" } }),
    "",
  ].join("\n"));
  state.sessions.set(sessionKey(source, sessionId), {
    source,
    sessionId,
    project: root,
    transcriptPath,
    lastEventAt: Date.now(),
  });

  acquireIndex(source, sessionId);
  await ensureIndexed(source, sessionId, transcriptPath);
  expect(getEventCount(source, sessionId)).toBe(2);
  expect((await readEvents(source, sessionId, transcriptPath, 0, 10)).length).toBe(2);
  expect(await readEventRaw(source, sessionId, transcriptPath, 0)).toContain("task_started");
  discardIndexIfUnused(source, sessionId);
  expect(state.eventByteOffsets.has(sessionKey(source, sessionId))).toBe(true);
  releaseIndex(source, sessionId);
  expect(state.eventByteOffsets.has(sessionKey(source, sessionId))).toBe(false);
});
