// A subagent's own transcript, read the way any other transcript is read.
//
// Separate from the session timeline rather than folded into it, and the reason is a trap in the
// data rather than a preference. Every record a subagent writes carries its PARENT's `sessionId`;
// the only things that distinguish it are `isSidechain` and an agent id. So anything that keys
// transcript content by session id will merge a subagent's messages into the session that
// launched it. Giving the run its own stream, addressed by parent session AND agent id, makes
// that mistake unrepresentable here instead of merely avoided.

import type { ActivityEvent } from "./activity.ts";

/**
 * Where a fork's context came from.
 *
 * Only a fork has one. It names the exact message in the parent transcript the run branched
 * from, so a viewer can show the branch point rather than implying the run began at the end of
 * the conversation. `contextLength` is how many messages it inherited.
 */
export interface SubagentForkOrigin {
  parentSessionId: string;
  parentMessageUuid: string;
  contextLength: number;
}

/**
 * One message on a subagent's transcript stream.
 *
 * The opening `snapshot` carries the whole run rather than a tail window. A subagent transcript
 * is small -- measured at 121 lines for a 25-turn run, against 7,935 for the session that
 * launched it -- so windowing it would add the paging arithmetic, and the reconnect-replaces-
 * history problem that comes with it, to buy nothing.
 */
export type SubagentTranscriptMessage =
  | {
      kind: "snapshot";
      agentId: string;
      events: ActivityEvent[];
      total: number;
      /** Present only for a fork, and only when its first record was still readable. */
      forkOrigin?: SubagentForkOrigin;
    }
  /** One event appended since the snapshot. Never a replacement for one already sent. */
  | { kind: "append"; event: ActivityEvent }
  /** No transcript exists at the derived path. A run can be launched and not yet have written. */
  | { kind: "unavailable"; reason: string };
