// A flow's life around its bind: messages that arrive before the body that names their session,
// turns that outrun it, and connections or captures that end mid-message. Split from the backend's
// main suite, which covers a flow already bound.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ClaudeLiveBackend } from "@/live/claudeLiveBackend";
import type { ObserverEvent } from "@/live/claudeNetworkSource";
import { delta, ended, flowEvent, flush, startFixture, type FixtureServer } from "@/live/fixtures/claudeLiveFixture";

describe("ClaudeLiveBackend flows around the bind", () => {
  // Each test builds its own backend over this one capture server.
  let fixture: FixtureServer;

  beforeAll(() => {
    fixture = startFixture();
  });

  afterAll(() => {
    fixture.stop();
  });

  test("a message arriving before the body bind is buffered, not dropped", async () => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("f2", "/v1/messages", "api.anthropic.com", "b2"));
    // These arrive before the body fetch resolves.
    local.acceptObserverEvent(delta("f2", { type: "message_start", message: { id: "msg_200" } }));
    local.acceptObserverEvent(delta("f2", { type: "content_block_start", index: 0, content_block: { type: "text" } }));
    local.acceptObserverEvent(
      delta("f2", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
    );
    local.acceptObserverEvent(delta("f2", { type: "message_stop" }));
    await flush(80);
    const page = await local.page("sess-b2", 0, 10, "nice");
    expect(page.events[0]!.blocks[0]!.text).toBe("ok");
    await local.dispose();
  });

  test("a whole turn that outruns its body fetch is mirrored, not thrown away", async () => {
    // The buffer a flow keeps until its session id arrives used to stop at 200 deltas, about
    // fifteen kilobytes, and a flow that reached it was deleted outright: a turn whose only sin
    // was streaming fast appeared nowhere, with nothing logged. 400 is past that and nowhere near
    // the byte bound that replaced it.
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("fast", "/v1/messages", "api.anthropic.com", "fast1"));
    local.acceptObserverEvent(delta("fast", { type: "message_start", message: { id: "msg_fast" } }));
    local.acceptObserverEvent(
      delta("fast", { type: "content_block_start", index: 0, content_block: { type: "text" } }),
    );
    for (let i = 0; i < 400; i++) {
      local.acceptObserverEvent(
        delta("fast", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } }),
      );
    }
    local.acceptObserverEvent(delta("fast", { type: "message_stop" }));
    await flush(160);
    const page = await local.page("sess-fast1", 0, 10, "nice");
    expect(page.total).toBe(1);
    expect(page.events[0]!.blocks[0]!.text).toBe("x".repeat(400));
    expect(page.events[0]!.phase).toBe("complete");
    await local.dispose();
  });

  test("a flow announced before its body was retained binds on the announcement that carries it", async () => {
    // The observer announces one flow more than once and the first announcement does not always
    // carry the body. That one used to create a context and schedule its drop, and the
    // announcement that did carry the body was then refused for having a context already.
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("late", "/v1/messages", "api.anthropic.com"));
    local.acceptObserverEvent(delta("late", { type: "message_start", message: { id: "msg_late" } }));
    local.acceptObserverEvent(
      delta("late", { type: "content_block_start", index: 0, content_block: { type: "text" } }),
    );
    local.acceptObserverEvent(
      delta("late", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "late" } }),
    );
    await flush(40);
    local.acceptObserverEvent(flowEvent("late", "/v1/messages", "api.anthropic.com", "late1"));
    local.acceptObserverEvent(delta("late", { type: "message_stop" }));
    await flush(160);
    const page = await local.page("sess-late1", 0, 10, "nice");
    expect(page.total).toBe(1);
    expect(page.events[0]!.blocks[0]!.text).toBe("late");
    await local.dispose();
  });

  test("a dropped observer connection finishes the message it was streaming", async () => {
    // The fixture has no viewer stream, so the subscription fails and the loop counts it as a
    // dropped connection, which is what the observer going away mid-message looks like here.
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("cut", "/v1/messages", "api.anthropic.com", "cut1"));
    local.acceptObserverEvent(delta("cut", { type: "message_start", message: { id: "msg_cut" } }));
    local.acceptObserverEvent(
      delta("cut", { type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    );
    await flush(160);
    expect((await local.page("sess-cut1", 0, 10, "nice")).events[0]!.phase).toBe("streaming");
    await local.start();
    await flush(160);
    expect((await local.page("sess-cut1", 0, 10, "nice")).events[0]!.phase).toBe("complete");
    await local.dispose();
  });

  test("a capture that dies finishes the messages it was recording", async () => {
    // proxy-agent never ends a flow whose capture died, so without this its message streams for
    // good. Measured: the capture exited mid-turn and the reply stayed a streaming thought.
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    const health = (sourceId: string, lifecycle: string): ObserverEvent => ({
      observedAt: new Date().toISOString(),
      captureHealthChanged: {
        health: { sourceId, lifecycle, failureCategory: "CAPTURE_FAILURE_CATEGORY_PROCESS_EXIT" },
      },
    });
    const open = (flowId: string, session: string, sourceId: string) => {
      const announced = flowEvent(flowId, "/v1/messages", "api.anthropic.com", session);
      announced.flowUpserted!.flow!.sourceId = sourceId;
      local.acceptObserverEvent(announced);
      local.acceptObserverEvent(delta(flowId, { type: "message_start", message: { id: `msg_${flowId}` } }));
      local.acceptObserverEvent(
        delta(flowId, { type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
      );
    };
    const phase = async (session: string) => (await local.page(`sess-${session}`, 0, 10, "nice")).events[0]!.phase;
    open("dying", "dying1", "cap-a");
    await flush(160);
    // The capture saying it is still running ends nothing of its own.
    local.acceptObserverEvent(health("cap-a", "CAPTURE_LIFECYCLE_RUNNING"));
    expect(await phase("dying1")).toBe("streaming");
    local.acceptObserverEvent(health("cap-a", "CAPTURE_LIFECYCLE_FAILED"));
    expect(await phase("dying1")).toBe("complete");
    // One capture runs at a time, so a different one taking over means the last is gone, whether
    // or not it said so first.
    open("next", "next1", "cap-b");
    await flush(160);
    expect(await phase("next1")).toBe("streaming");
    local.acceptObserverEvent(health("cap-c", "CAPTURE_LIFECYCLE_STARTING"));
    expect(await phase("next1")).toBe("complete");
    await local.dispose();
  });

  test("a flow that ends before it binds, with no message_stop, still finishes its message", async () => {
    const local = new ClaudeLiveBackend(fixture.url, true, 8);
    local.acceptObserverEvent(flowEvent("early", "/v1/messages", "api.anthropic.com", "early1"));
    local.acceptObserverEvent(delta("early", { type: "message_start", message: { id: "msg_early" } }));
    local.acceptObserverEvent(
      delta("early", { type: "content_block_start", index: 0, content_block: { type: "text" } }),
    );
    local.acceptObserverEvent(ended("early"));
    await flush(160);
    expect((await local.page("sess-early1", 0, 10, "nice")).events[0]!.phase).toBe("complete");
    await local.dispose();
  });
});
