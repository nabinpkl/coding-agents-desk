// An SDK session's streamed messages, into the live mirror (ADR-0143).
//
// The runner forwards every message `claude` sends, and the stream events among them -- text,
// thinking, tool input -- are in the shape the proxy capture decodes, so the mirror applies them the
// same way (`SdkSession.fold` picks them out).
// This is the session's own account rather than a copy read off the network: it cannot be dropped
// by a capture that dies mid-turn, which is the failure the capture path documents. While a runner
// feeds a session the mirror drops that session's captured flows rather than racing two writers
// over one row.
//
// One flow per message, from `message_start` to `message_stop`, which is what one captured request
// is. A message whose start this sidecar did not see -- it connected, or restarted, mid-message -- is
// left to the transcript rather than drawn from its middle.

import type { RunnerStreamFrame } from "@/claude-sdk/claudeSdkProtocol";

/** The part of the live backend this feeds. */
export interface RunnerStreamTarget {
  acceptRunnerStream(sessionId: string, flowId: string, payload: string | null, ts: number): void;
  releaseRunnerStream(sessionId: string): void;
}

export class ClaudeSdkLiveFeed {
  /** The message each session is in the middle of, by the flow it was given. */
  private readonly open = new Map<string, string>();
  private sequence = 0;

  constructor(
    private readonly target: RunnerStreamTarget,
    private readonly now: () => number = Date.now,
  ) {}

  stream(sessionId: string, frame: RunnerStreamFrame): void {
    // A subagent's message belongs to the subagent's own transcript, as the capture path decides.
    if (frame.parentToolUseId !== null) return;
    if (frame.event.type === "message_start") {
      this.end(sessionId);
      this.open.set(sessionId, `sdk-runner:${sessionId}:${++this.sequence}`);
    }
    const flowId = this.open.get(sessionId);
    if (!flowId) return;
    this.target.acceptRunnerStream(sessionId, flowId, JSON.stringify(frame.event), this.now());
    if (frame.event.type === "message_stop") this.end(sessionId);
  }

  /** The runner went away: its message in progress ends, and the capture is the account again. */
  gone(sessionId: string): void {
    this.end(sessionId);
    this.target.releaseRunnerStream(sessionId);
  }

  private end(sessionId: string): void {
    const flowId = this.open.get(sessionId);
    if (!flowId) return;
    this.open.delete(sessionId);
    this.target.acceptRunnerStream(sessionId, flowId, null, this.now());
  }
}
