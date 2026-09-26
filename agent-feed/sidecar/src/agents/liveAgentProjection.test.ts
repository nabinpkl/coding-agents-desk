import { describe, expect, test } from "bun:test";
import {
  LiveAgentProjection,
  sanitizeAgentValue,
  type TimelineEnvelope,
} from "@/agents/liveAgentProjection";

describe("LiveAgentProjection", () => {
  test("replaces one stable item with increasing revisions", () => {
    const projection = new LiveAgentProjection({ replayLimit: 8 });
    const envelopes: TimelineEnvelope[] = [];
    projection.subscribe(0, (envelope) => envelopes.push(envelope));

    const first = projection.upsert({
      id: "assistant:1",
      ts: 1,
      type: "assistant",
      phase: "streaming",
      blocks: [{ kind: "text", text: "hel" }],
    });
    const duplicate = projection.upsert({
      id: "assistant:1",
      ts: 1,
      type: "assistant",
      phase: "streaming",
      blocks: [{ kind: "text", text: "hel" }],
    });
    const final = projection.upsert({
      id: "assistant:1",
      ts: 1,
      type: "assistant",
      phase: "complete",
      blocks: [{ kind: "text", text: "hello" }],
    });

    expect(first).toMatchObject({ index: 0, revision: 0 });
    expect(duplicate).toBe(first);
    expect(final).toMatchObject({ index: 0, revision: 1, phase: "complete" });
    expect(envelopes.filter((item) => item.kind === "upsert")).toHaveLength(2);
  });

  test("names the projection instance on every envelope", () => {
    const first = new LiveAgentProjection({ projectionId: "projection-a" });
    const second = new LiveAgentProjection({ projectionId: "projection-b" });
    const envelopes: TimelineEnvelope[] = [];
    first.subscribe(0, (envelope) => envelopes.push(envelope));
    first.upsert({
      id: "event:1",
      ts: 1,
      type: "system",
      phase: "complete",
      blocks: [{ kind: "metadata", text: "one" }],
    });

    expect(envelopes[0]?.projectionId).toBe("projection-a");
    expect(first.snapshot().projectionId).toBe("projection-a");
    expect(second.snapshot().projectionId).toBe("projection-b");
  });

  test("replaces stale rows and rotates the projection identity", () => {
    const projection = new LiveAgentProjection({ projectionId: "projection-before" });
    const envelopes: TimelineEnvelope[] = [];
    projection.subscribe(0, (envelope) => envelopes.push(envelope));
    projection.upsert({
      id: "stale",
      ts: 1,
      type: "assistant",
      phase: "complete",
      blocks: [{ kind: "text", text: "before" }],
    });
    const before = projection.projectionId;
    projection.replace(() => {
      projection.upsert({
        id: "current",
        ts: 2,
        type: "system",
        phase: "complete",
        blocks: [{ kind: "compaction", summary: "after" }],
      });
    });

    expect(projection.total).toBe(1);
    expect(projection.page(0, 1)[0]?.id).toBe("current");
    expect(projection.projectionId).not.toBe(before);
    expect(envelopes.at(-1)).toMatchObject({ kind: "snapshot", projectionId: projection.projectionId });
  });

  test("replays retained mutations and snapshots an expired gap", () => {
    const projection = new LiveAgentProjection({ replayLimit: 2 });
    for (let index = 0; index < 3; index += 1) {
      projection.upsert({
        id: `event:${index}`,
        ts: index,
        type: "system",
        phase: "complete",
        blocks: [{ kind: "metadata", text: String(index) }],
      });
    }

    const replay: TimelineEnvelope[] = [];
    projection.subscribe(1, (envelope) => replay.push(envelope))();
    expect(replay.map((item) => item.sequence)).toEqual([2, 3]);
    expect(replay.every((item) => item.kind === "upsert")).toBe(true);

    const snapshot: TimelineEnvelope[] = [];
    projection.subscribe(0, (envelope) => snapshot.push(envelope))();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ kind: "snapshot", sequence: 3, total: 3 });
    expect(snapshot[0]?.events.map((event) => event.id)).toEqual([
      "event:0",
      "event:1",
      "event:2",
    ]);
  });

  test("recovers an expired gap from the newest bounded window", () => {
    const projection = new LiveAgentProjection({ replayLimit: 2 });
    for (let index = 0; index < 150; index += 1) {
      projection.upsert({
        id: `event:${index}`,
        ts: index,
        type: "system",
        phase: "complete",
        blocks: [{ kind: "metadata", text: String(index) }],
      });
    }

    const recovered: TimelineEnvelope[] = [];
    projection.subscribe(0, (envelope) => recovered.push(envelope))();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      kind: "snapshot",
      sequence: 150,
      windowStart: 50,
      total: 150,
    });
    expect(recovered[0]?.events).toHaveLength(100);
    expect(recovered[0]?.events[0]?.id).toBe("event:50");
    expect(recovered[0]?.events.at(-1)?.id).toBe("event:149");
  });

  test("publishes run and queue state without transcript rows", () => {
    const projection = new LiveAgentProjection();
    const envelopes: TimelineEnvelope[] = [];
    projection.subscribe(0, (envelope) => envelopes.push(envelope));
    projection.setState("running", { steer: 1, followUp: 2 });
    expect(projection.total).toBe(0);
    expect(envelopes.at(-1)).toMatchObject({
      kind: "state",
      runState: "running",
      queue: { steer: 1, followUp: 2 },
    });
  });
});

describe("sanitizeAgentValue", () => {
  test("bounds cycles, depth, properties, prototype keys, and output bytes", () => {
    const cyclic: Record<string, unknown> = {
      ok: "x".repeat(200),
      __proto__: "blocked",
      constructor: "blocked",
    };
    cyclic.self = cyclic;
    cyclic.deep = { one: { two: { three: "end" } } };
    const sanitized = sanitizeAgentValue(cyclic, {
      maximumBytes: 80,
      maximumDepth: 2,
      maximumProperties: 4,
    });
    const serialized = JSON.stringify(sanitized);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(80);
    expect(serialized).not.toContain("constructor");
    expect(serialized).toContain("truncated");
  });
});
