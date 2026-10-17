import { describe, expect, test } from "bun:test";
import { ClaudeSdkLiveFeed, type RunnerStreamTarget } from "@/claude-sdk/claudeSdkLiveFeed";
import type { RunnerStreamFrame } from "@/claude-sdk/claudeSdkProtocol";

function recording() {
  const calls: string[] = [];
  const target: RunnerStreamTarget = {
    acceptRunnerStream: (sessionId, flowId, payload) =>
      void calls.push(`${sessionId} ${flowId} ${payload === null ? "END" : (JSON.parse(payload) as { type: string }).type}`),
    releaseRunnerStream: (sessionId) => void calls.push(`${sessionId} released`),
  };
  return { calls, feed: new ClaudeSdkLiveFeed(target, () => 1) };
}

const frame = (type: string, parentToolUseId: string | null = null): RunnerStreamFrame =>
  ({ type: "stream", event: { type }, parentToolUseId });

describe("a runner's stream, into the live mirror", () => {
  test("is one flow per message, from its start to its stop", () => {
    const { calls, feed } = recording();
    for (const type of ["message_start", "content_block_delta", "message_stop", "message_start", "message_stop"]) {
      feed.stream("s", frame(type));
    }
    expect(calls).toEqual([
      "s sdk-runner:s:1 message_start",
      "s sdk-runner:s:1 content_block_delta",
      "s sdk-runner:s:1 message_stop",
      "s sdk-runner:s:1 END",
      "s sdk-runner:s:2 message_start",
      "s sdk-runner:s:2 message_stop",
      "s sdk-runner:s:2 END",
    ]);
  });

  test("leaves a message it joined in the middle, and a subagent's, to the transcript", () => {
    const { calls, feed } = recording();
    feed.stream("s", frame("content_block_delta"));
    feed.stream("s", frame("message_stop"));
    feed.stream("s", frame("message_start", "toolu_agent"));
    expect(calls).toEqual([]);
  });

  test("ends the message in progress and gives the session back when the runner goes", () => {
    const { calls, feed } = recording();
    feed.stream("s", frame("message_start"));
    feed.gone("s");
    expect(calls).toEqual(["s sdk-runner:s:1 message_start", "s sdk-runner:s:1 END", "s released"]);
  });
});
