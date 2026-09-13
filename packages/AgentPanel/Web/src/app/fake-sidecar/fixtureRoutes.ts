// The fake sidecar's routing table: which request path answers with what, and the
// live turn it dribbles out one frame at a time.

import type {
  ActivityEvent,
  EventMode,
  SourceId,
  TimelineMessage,
} from "@agentdesk/agent-feed-wire";
import {
  FIXTURE_PROJECTS,
  PROJECT_PATH,
  FIXTURE_RAW_LINE,
  FIXTURE_SESSIONS,
  fixtureEvents,
} from "@/app/fake-sidecar/fixtureData";

/** What one request answers with: a status, then zero or more messages, then an end. */
export interface FixtureRoute {
  status: number;
  /** Each entry is one complete message: a whole body for a request, one event for a stream. */
  messages: Array<{ delay: number; payload: string }>;
  /** Streams stay open after their scripted messages; one-shot requests end. */
  keepOpen?: boolean;
}

function timeline(mode: EventMode): FixtureRoute {
  const events = fixtureEvents(mode);
  const snapshot: TimelineMessage = {
    type: "timeline",
    envelope: {
      kind: "snapshot",
      sequence: events.length,
      mode,
      events,
      windowStart: 0,
      // One past the seed, because a live chunk follows.
      total: events.length + 1,
      runState: "running",
      queue: { steer: 0, followUp: 0 },
      // Occupancy on the seed. Claude publishes no window in the transcript, so the sidecar
      // resolves it; this is the resolved shape the panel actually sees.
      usage: { current: 68_272, limit: 200_000, updatedAt: Date.now() - 190_000, model: "claude-opus-5" },
    },
  };
  const appended: TimelineMessage = {
    type: "timeline",
    envelope: {
      kind: "upsert",
      sequence: events.length + 1,
      mode,
      events: [
        {
          id: "fixture-live",
          index: events.length,
          otherModeIndex: null,
          revision: 0,
          phase: "complete",
          ts: Date.now(),
          type: "assistant",
          blocks: [{ kind: "text", text: "The layered webview contract is connected." }],
        },
      ],
      windowStart: 0,
      total: events.length + 1,
      runState: "idle",
      queue: { steer: 0, followUp: 0 },
      // A later, larger reading on the appended envelope, so the fixture exercises the thing the
      // whole stage is for: the meter moving without a reload.
      usage: { current: 152_940, limit: 200_000, updatedAt: Date.now(), model: "claude-opus-5" },
    },
  };
  return {
    status: 200,
    keepOpen: true,
    messages: [
      { delay: 40, payload: JSON.stringify(snapshot) },
      { delay: 120, payload: JSON.stringify(appended) },
      ...liveTurn(mode, events.length + 1),
    ],
  };
}

/**
 * A whole streaming turn, then the transcript taking it over.
 *
 * The fixture could show every durable shape and no live one, which left the row a
 * reader actually watches -- the one still arriving -- judgeable only against a real
 * agent. It matters most for exactly the thing this row is built around: the message
 * grows, gains a tool call, completes, and is replaced by its durable self, and none
 * of that may move the paragraph being read.
 *
 * Written as growing whole texts rather than deltas because that is what the mirror
 * publishes: it accumulates into its blocks and republishes the message each time.
 */
function liveTurn(mode: EventMode, sequence: number): Array<{ delay: number; payload: string }> {
  // A turn that thinks before it answers, because that is the shape most turns
  // have and the one the row is hardest to get right for: the reasoning is most
  // of what is on screen, and it has to reveal the way the prose under it does
  // rather than land in phrase-sized jumps beside it.
  const reasoning = [
    "**Checking the excerpt** The line",
    "**Checking the excerpt** The line numbers come from the reader, not the file, so",
    "**Checking the excerpt** The line numbers come from the reader, not the file, so a match written against them was never going to find anything.",
  ];
  const prose = [
    "Reading the",
    "Reading the failing line. The **replacement** did not match, so",
    "Reading the failing line. The **replacement** did not match, so the file on disk\nstill has its original text.\n\nChecking whether the excerpt strips the leading tab.",
  ];
  const tail = (blocks: ActivityEvent["blocks"], phase: "streaming" | "complete"): TimelineMessage => ({
    type: "tail",
    event: {
      id: "fixture-tail",
      index: -1,
      otherModeIndex: null,
      revision: 0,
      phase,
      ts: Date.now(),
      type: "assistant",
      messageId: "msg_fixture_tail",
      blocks,
    },
  });
  const thought = (step: number) => ({ kind: "reasoning" as const, text: reasoning[step]! });
  const withTool = [thought(2), { kind: "text" as const, text: prose[2]! }, {
    kind: "tool_use" as const,
    tool: "Read",
    summary: "packages/AgentPanel/Web/src/features/activity-feed/ActivityFeed.tsx",
    callId: "fixture-call",
  }];
  // Absolute from the moment the stream opens, not gaps between messages: the
  // fixture arms one timer per message off a single open, so a "delay" read as a
  // gap would fire the end of the turn before its beginning.
  return [
    ...reasoning.map((_, step) => ({
      delay: 900 + step * 700,
      payload: JSON.stringify(tail([thought(step)], "streaming")),
    })),
    // The trace stops growing where the answer starts, exactly as the backends
    // publish it: one message whose blocks accumulate, not two messages.
    ...prose.map((text, step) => ({
      delay: 3_000 + step * 700,
      payload: JSON.stringify(tail([thought(2), { kind: "text", text }], "streaming")),
    })),
    { delay: 5_100, payload: JSON.stringify(tail(withTool, "streaming")) },
    { delay: 5_800, payload: JSON.stringify(tail(withTool, "complete")) },
    // The handoff: the same message, now a transcript line. The panel drops the tail
    // on the messageId match, so the two never appear at once.
    {
      delay: 6_500,
      payload: JSON.stringify({
        type: "timeline",
        envelope: {
          kind: "upsert",
          sequence: sequence + 1,
          mode,
          events: [{
            id: "fixture-tail-durable",
            index: sequence,
            otherModeIndex: null,
            revision: 0,
            phase: "complete",
            ts: Date.now(),
            type: "assistant",
            messageId: "msg_fixture_tail",
            blocks: withTool,
          }],
          windowStart: 0,
          total: sequence + 1,
          runState: "idle",
          queue: { steer: 0, followUp: 0 },
        },
      } satisfies TimelineMessage),
    },
  ];
}

/** Resolves one request path to its canned answer, or null for 404. */
export function route(method: string, path: string): FixtureRoute | null {
  const [pathname, query = ""] = path.split("?");
  const parameters = new URLSearchParams(query);
  const mode: EventMode = parameters.get("mode") === "nice" ? "nice" : "raw";

  if (pathname === "/api/inventory/stream") {
    // `projectPath`, repeated, because that is what the sidecar's route reads. This
    // fixture stands in for the sidecar, so a name invented here is a name the real
    // route will refuse -- and it will refuse it with a 400 the whole test suite is
    // happy to never see.
    const messages = [
      { delay: 30, payload: JSON.stringify({ projects: FIXTURE_PROJECTS }) },
      ...parameters.getAll("projectPath").map((projectPath) => ({
        delay: 30,
        payload: JSON.stringify({
          projectPath,
          sessions: projectPath === PROJECT_PATH ? FIXTURE_SESSIONS : [],
        }),
      })),
    ];
    return { status: 200, keepOpen: true, messages };
  }
  if (pathname?.endsWith("/timeline")) return timeline(mode);
  if (pathname?.endsWith("/raw")) {
    return { status: 200, messages: [{ delay: 30, payload: FIXTURE_RAW_LINE }] };
  }
  if (method === "POST") {
    // Commands are accepted and do nothing. The fixture has no agent to run them.
    return {
      status: 202,
      messages: [{ delay: 20, payload: JSON.stringify({ requestId: "fixture", delivery: "immediate" }) }],
    };
  }
  return null;
}
