import { afterEach, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ActivityEvent, TimelineEnvelope, TokenUsage } from "@agentdesk/agent-feed-wire";
import { createTimelineFollower, TIMELINE_WINDOW } from "@/http/session-routes/timelineCheckpoint";
import { subscribeTranscriptTimeline } from "@/http/session-routes/sessionRoutes";
import { syncIndex } from "@/transcripts/event-index/eventIndex";
import { sessionKey } from "@/transcripts/catalog/transcriptCatalog";
import { state } from "@/transcripts/transcriptState";

function event(index: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: `e${index}`,
    index,
    revision: 0,
    phase: "complete",
    ts: index,
    type: "assistant",
    blocks: [],
    ...overrides,
  };
}

/**
 * Offers every event and returns what the follower decided to write.
 *
 * The flush is a microtask, so one `await` after the offers is what lets it run -- which is also
 * the property being relied on in the route: one synchronous run of the index's scan is one
 * decision.
 */
async function written(
  events: ActivityEvent[],
  options: { window?: number; usage?: TokenUsage | null } = {},
): Promise<TimelineEnvelope[]> {
  const envelopes: TimelineEnvelope[] = [];
  const follower = createTimelineFollower({
    mode: "nice",
    stableIndices: true,
    usage: () => options.usage ?? null,
    emit: (envelope) => envelopes.push(envelope),
    window: options.window,
  });
  for (const item of events) follower.offer(item);
  await Promise.resolve();
  return envelopes;
}

function range(start: number, count: number): ActivityEvent[] {
  return Array.from({ length: count }, (_, offset) => event(start + offset));
}

test("a reader who is keeping up is sent the rows themselves", async () => {
  const envelopes = await written(range(40, 3));
  expect(envelopes.map((envelope) => envelope.kind)).toEqual(["upsert", "upsert", "upsert"]);
  expect(envelopes.map((envelope) => envelope.events[0]!.index)).toEqual([40, 41, 42]);
  // Each row names itself as the whole of what it is about, which is what the panel upserts on.
  expect(envelopes[0]).toMatchObject({ windowStart: 40, total: 41, sequence: 41 });
});

test("a window's worth at once is still rows, not a checkpoint", async () => {
  const envelopes = await written(range(0, TIMELINE_WINDOW));
  expect(envelopes).toHaveLength(TIMELINE_WINDOW);
  expect(new Set(envelopes.map((envelope) => envelope.kind))).toEqual(new Set(["upsert"]));
});

test("more than a window at once is one checkpoint of the newest rows", async () => {
  // The shape a resumed session writes: the whole prior conversation landing at once, long after
  // the reader was told where the record ended.
  const envelopes = await written(range(0, 598));
  expect(envelopes).toHaveLength(1);
  const checkpoint = envelopes[0]!;
  expect(checkpoint.kind).toBe("snapshot");
  expect(checkpoint.events).toHaveLength(TIMELINE_WINDOW);
  expect(checkpoint.events[0]!.index).toBe(598 - TIMELINE_WINDOW);
  expect(checkpoint.events.at(-1)!.index).toBe(597);
  expect(checkpoint.windowStart).toBe(598 - TIMELINE_WINDOW);
  expect(checkpoint.total).toBe(598);
});

test("a checkpoint says its indices are stable, so scrollback survives it", async () => {
  // The panel keeps what it had paged in below `windowStart` only on this flag. Without it a
  // checkpoint would throw away a reader's scrollback every time one arrived.
  const envelopes = await written(range(0, 240));
  expect(envelopes[0]!.stableIndices).toBe(true);
});

test("occupancy is read when the envelope is written, on both paths", async () => {
  const usage: TokenUsage = { current: 1200, limit: 200_000, updatedAt: 7 };
  const rows = await written(range(0, 2), { usage });
  expect(rows[0]!.usage).toEqual(usage);
  const checkpoint = await written(range(0, 240), { usage });
  expect(checkpoint[0]!.usage).toEqual(usage);
});

test("an event re-notified for its cache badge replaces the row rather than doubling it", async () => {
  // The index re-emits an already-delivered event with a bumped revision to hang a cache-hit
  // badge on it. Two entries for one index would deliver the stale row after the fresh one.
  const envelopes = await written([
    event(4),
    event(5),
    event(4, { revision: 1, cacheHit: { cached: 900, input: 1000 } }),
  ]);
  expect(envelopes).toHaveLength(2);
  expect(envelopes.map((envelope) => envelope.events[0]!.index)).toEqual([4, 5]);
  expect(envelopes[0]!.events[0]!.revision).toBe(1);
  expect(envelopes[0]!.events[0]!.cacheHit).toEqual({ cached: 900, input: 1000 });
});

test("rows are written in index order whatever order they were offered in", async () => {
  const envelopes = await written([event(9), event(7), event(8)]);
  expect(envelopes.map((envelope) => envelope.events[0]!.index)).toEqual([7, 8, 9]);
});

test("a reader that leaves is not written to", async () => {
  const envelopes: TimelineEnvelope[] = [];
  const follower = createTimelineFollower({
    mode: "raw",
    stableIndices: true,
    usage: () => null,
    emit: (envelope) => envelopes.push(envelope),
  });
  follower.offer(event(1));
  follower.close();
  follower.offer(event(2));
  await Promise.resolve();
  expect(envelopes).toEqual([]);
});

test("each catch-up decides on its own, so a burst does not make the next row a checkpoint", async () => {
  const envelopes: TimelineEnvelope[] = [];
  const follower = createTimelineFollower({
    mode: "nice",
    stableIndices: true,
    usage: () => null,
    emit: (envelope) => envelopes.push(envelope),
    window: 4,
  });
  for (const item of range(0, 10)) follower.offer(item);
  await Promise.resolve();
  follower.offer(event(10));
  await Promise.resolve();
  expect(envelopes.map((envelope) => envelope.kind)).toEqual(["snapshot", "upsert"]);
  expect(envelopes[1]!.events[0]!.index).toBe(10);
});

// --------------------------------------------------------------------------
// The same rule on the real path: a transcript that grows past the reader.
// --------------------------------------------------------------------------

const SOURCE = "codex" as const;
const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const roots: string[] = [];

afterEach(async () => {
  state.sessions.clear();
  state.eventByteOffsets.clear();
  state.niceToRaw.clear();
  state.indexedSizes.clear();
  state.indexed.clear();
  state.indexBuilds.clear();
  state.indexResyncs.clear();
  state.indexReferences.clear();
  state.sessionUsage.clear();
  state.eventSubscribers.clear();
  state.transcriptFollows.clear();
  state.transcriptWatchedPaths.clear();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** One content line, the shape the codex adapter turns into a visible event. */
function contentLine(turn: number): string {
  return JSON.stringify({
    timestamp: `2026-01-01T00:00:${String(turn % 60).padStart(2, "0")}Z`,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: `turn ${turn}` }],
    },
  });
}

async function waitFor(settled: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!settled() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("a transcript that grows past a window after the stream opened hands over a checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-checkpoint-"));
  roots.push(root);
  const transcriptPath = join(root, "rollout.jsonl");
  const opening = [0, 1, 2].map(contentLine);
  await writeFile(transcriptPath, `${opening.join("\n")}\n`);
  const key = sessionKey(SOURCE, SESSION_ID);
  state.sessions.set(key, {
    source: SOURCE,
    sessionId: SESSION_ID,
    project: root,
    transcriptPath,
    lastEventAt: Date.now(),
  });
  // Pinned so the process's real watcher never takes this path: `watchTranscript` re-points a
  // path it already holds instead of adding it. Growth is driven by the explicit `syncIndex`
  // below, which is exactly what the watcher would have called, and the test stops being a race
  // between a filesystem event and its own assertions.
  state.transcriptWatchedPaths.set(transcriptPath, key);

  const envelopes: TimelineEnvelope[] = [];
  const errors: string[] = [];
  // `after` is the opening window's own sequence, which is how the timeline route follows: the
  // reader already holds those three rows.
  const stop = subscribeTranscriptTimeline(SOURCE, SESSION_ID, 3, "nice", {
    onEnvelope: (envelope) => envelopes.push(envelope),
    onError: (message) => errors.push(message),
  });
  expect(stop).not.toBeNull();
  await waitFor(() => (state.eventSubscribers.get(key)?.size ?? 0) > 0);
  expect(envelopes).toEqual([]);

  // The shape a resumed session writes: the whole prior conversation at once, after the reader
  // was told where the record ended.
  const replayed = Array.from({ length: 240 }, (_, offset) => contentLine(offset + 3));
  await appendFile(transcriptPath, `${replayed.join("\n")}\n`);
  await syncIndex(SOURCE, SESSION_ID, transcriptPath);
  await Promise.resolve();

  expect(errors).toEqual([]);
  // One message carrying the end of the record, not 240 appends walking a reader through it.
  expect(envelopes).toHaveLength(1);
  const checkpoint = envelopes[0]!;
  expect(checkpoint.kind).toBe("snapshot");
  expect(checkpoint.total).toBe(243);
  expect(checkpoint.windowStart).toBe(243 - TIMELINE_WINDOW);
  expect(checkpoint.events).toHaveLength(TIMELINE_WINDOW);
  expect(checkpoint.stableIndices).toBe(true);
  stop!();
});

test("an ordinary turn's rows still arrive as rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-checkpoint-live-"));
  roots.push(root);
  const transcriptPath = join(root, "rollout.jsonl");
  await writeFile(transcriptPath, `${contentLine(0)}\n`);
  const key = sessionKey(SOURCE, SESSION_ID);
  state.sessions.set(key, {
    source: SOURCE,
    sessionId: SESSION_ID,
    project: root,
    transcriptPath,
    lastEventAt: Date.now(),
  });
  state.transcriptWatchedPaths.set(transcriptPath, key);

  const envelopes: TimelineEnvelope[] = [];
  const stop = subscribeTranscriptTimeline(SOURCE, SESSION_ID, 1, "nice", {
    onEnvelope: (envelope) => envelopes.push(envelope),
    onError: () => {},
  });
  await waitFor(() => (state.eventSubscribers.get(key)?.size ?? 0) > 0);

  await appendFile(transcriptPath, `${[1, 2, 3].map(contentLine).join("\n")}\n`);
  await syncIndex(SOURCE, SESSION_ID, transcriptPath);
  await Promise.resolve();

  expect(envelopes.map((envelope) => envelope.kind)).toEqual(["upsert", "upsert", "upsert"]);
  expect(envelopes.map((envelope) => envelope.events[0]!.index)).toEqual([1, 2, 3]);
  stop!();
});

test("a record that renumbers says its checkpoint replaces what the reader held", async () => {
  // The other half of the flag. A projection's indices are arithmetic about a session that may no
  // longer exist, so a reader must not keep rows below the window on the strength of them.
  const envelopes: TimelineEnvelope[] = [];
  const follower = createTimelineFollower({
    mode: "nice",
    stableIndices: false,
    usage: () => null,
    emit: (envelope) => envelopes.push(envelope),
    window: 4,
  });
  for (const item of range(0, 10)) follower.offer(item);
  await Promise.resolve();
  expect(envelopes[0]!.kind).toBe("snapshot");
  expect(envelopes[0]!.stableIndices).toBe(false);
});
