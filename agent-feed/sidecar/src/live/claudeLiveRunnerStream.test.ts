// An SDK session's runner as the live mirror's source (ADR-0143): its messages are drawn the way a
// captured flow's are, and while it feeds a session the capture of that session is not raced in.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ClaudeLiveBackend } from "@/live/claudeLiveBackend";
import { delta, ended, flowEvent, startFixture, type FixtureServer } from "@/live/fixtures/claudeLiveFixture";

const message = (id: string, text: string) => [
  { type: "message_start", message: { id, model: "claude-haiku-4-5", usage: { input_tokens: 5, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "message_stop" },
];

describe("a runner-fed session", () => {
  let fixture: FixtureServer;
  let backend: ClaudeLiveBackend;
  const sessionId = "sess-rf1";

  beforeAll(() => {
    fixture = startFixture();
    backend = new ClaudeLiveBackend(fixture.url, true, 8);
  });

  afterAll(async () => {
    await backend.dispose();
    fixture.stop();
  });

  const capture = async (flowId: string, id: string, text: string) => {
    backend.acceptObserverEvent(flowEvent(flowId, "/v1/messages", "api.anthropic.com", "rf1"));
    for (const event of message(id, text)) backend.acceptObserverEvent(delta(flowId, event));
    backend.acceptObserverEvent(ended(flowId));
    await fixture.settled();
  };

  test("draws the runner's message, finished at its stop, under the API's message id", async () => {
    for (const event of message("msg_r1", "from the runner")) {
      backend.acceptRunnerStream(sessionId, "sdk-runner:1", JSON.stringify(event), 1000);
    }
    backend.acceptRunnerStream(sessionId, "sdk-runner:1", null, 1001);
    const page = await backend.page(sessionId, 0, 10, "nice");
    expect(page.total).toBe(1);
    expect(page.events[0]).toMatchObject({ id: "claude-live:msg_r1", phase: "complete" });
    expect(page.events[0]!.blocks[0]!.text).toBe("from the runner");
  });

  test("drops the capture of the same session while the runner feeds it", async () => {
    await capture("cap1", "msg_c1", "from the capture");
    const page = await backend.page(sessionId, 0, 10, "nice");
    expect(page.total).toBe(1);
    expect(JSON.stringify(page.events)).not.toContain("from the capture");
  });

  test("takes the capture again once the runner has gone", async () => {
    backend.releaseRunnerStream(sessionId);
    await capture("cap2", "msg_c2", "the capture again");
    const page = await backend.page(sessionId, 0, 10, "nice");
    expect(page.total).toBe(2);
    expect(JSON.stringify(page.events)).toContain("the capture again");
  });
});
