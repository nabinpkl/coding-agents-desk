import { describe, expect, test } from "bun:test";
import type { BotRecord, ClaudeSessionActivity } from "@agentdesk/agent-feed-wire";
import type { ClaudeSessionProcess } from "@/tasks/sessionRegistry";
import {
  idleCandidates,
  keptSessions,
  sweepIdleSessions,
  type IdleSweepSources,
  type SweepPane,
} from "@/terminal/session-panes/idleSessionSweep";

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

/** The pane's process is 10; a Claude process is 11, under it, unless a test puts it elsewhere. */
const PARENTS = new Map([[11, 10], [21, 20]]);

function process(sessionId: string, activity: ClaudeSessionActivity | null = "idle", pid = 11): ClaudeSessionProcess {
  return {
    pid,
    sessionId,
    cwd: "/repo",
    startedAt: 0,
    messagingSocketPath: null,
    entrypoint: "cli",
    tmuxSession: null,
    waiting: false,
    activity,
    version: null,
    name: null,
  };
}

function pane(session: string, stamp: string, attached = 0): SweepPane {
  return { session, stamp, attached, pid: 10 };
}

function live(...processes: ClaudeSessionProcess[]) {
  return { live: processes, parentOf: PARENTS };
}

function bot(over: Partial<BotRecord>): BotRecord {
  return { botId: "b", name: "b", sessionRefs: [], ...over } as BotRecord;
}

/** Every rule reads one session, `dylan`, quiet for three hours unless a test says otherwise. */
function candidates(over: Partial<Parameters<typeof idleCandidates>[0]> = {}) {
  return idleCandidates({
    panes: [pane("dylan", "s-dylan")],
    processes: live(process("s-dylan")),
    kept: new Set(),
    lastEventAt: () => NOW - 3 * HOUR,
    now: NOW,
    idleAfterMs: 2 * HOUR,
    ...over,
  });
}

describe("which sessions the sweep closes", () => {
  test("one off the canvas, idle by its own registry, and quiet past the threshold", () => {
    expect(candidates()).toEqual([{ session: "dylan", sessionId: "s-dylan", idleMs: 3 * HOUR }]);
  });

  test("not one quiet for less than the threshold", () => {
    expect(candidates({ lastEventAt: () => NOW - HOUR })).toEqual([]);
  });

  test("not one whose session is busy anywhere, even in a pane other than this one", () => {
    expect(candidates({ processes: live(process("s-dylan"), process("s-dylan", "busy", 21)) })).toEqual([]);
  });

  test("not one mid-turn, in a dialog, running a background shell, or of unknown state", () => {
    for (const activity of ["busy", "waiting", "shell", null] as const) {
      expect(candidates({ processes: live(process("s-dylan", activity)) })).toEqual([]);
    }
  });

  test("not one held on the canvas", () => {
    expect(candidates({ kept: new Set(["s-dylan"]) })).toEqual([]);
  });

  test("not a pane this sidecar did not start, one somebody is attached to, or one with company", () => {
    expect(candidates({ panes: [pane("notes", "")] })).toEqual([]);
    expect(candidates({ panes: [pane("dylan", "s-dylan", 1)] })).toEqual([]);
    expect(candidates({ panes: [pane("dylan", "s-dylan"), pane("dylan", "s-dylan")] })).toEqual([]);
  });

  test("not a pane whose agent has exited or runs elsewhere, nor one the catalog has not read", () => {
    expect(candidates({ processes: live() })).toEqual([]);
    expect(candidates({ processes: live(process("s-dylan", "idle", 21)) })).toEqual([]);
    expect(candidates({ lastEventAt: () => null })).toEqual([]);
  });
});

describe("what the canvas keeps", () => {
  test("its Bots' sessions, less the ones taken off it, and every Father session", () => {
    const kept = keptSessions([
      bot({
        sessionRefs: [{ source: "claude", sessionId: "on" }, { source: "claude", sessionId: "off" }],
        offCanvasSessionRefs: [{ source: "claude", sessionId: "off" }],
      }),
      bot({ offCanvas: true, sessionRefs: [{ source: "claude", sessionId: "hidden" }] }),
      bot({ offCanvas: true, fatherSession: { source: "claude", sessionId: "father" } }),
    ]);
    expect([...kept].sort()).toEqual(["father", "on"]);
  });
});

describe("a sweep", () => {
  function sources(activities: (ClaudeSessionActivity | null)[]): IdleSweepSources & { closed: string[]; said: string[] } {
    const closed: string[] = [];
    const said: string[] = [];
    let asked = 0;
    return {
      closed,
      said,
      processes: async () => live(process("s-dylan", activities[Math.min(asked++, activities.length - 1)]!)),
      panes: async () => [pane("dylan", "s-dylan")],
      lastEventAt: () => NOW - 3 * HOUR,
      bots: async () => [],
      close: async (session) => {
        closed.push(session);
      },
      now: () => NOW,
      log: (message) => said.push(message),
    };
  }

  test("closes and says so", async () => {
    const io = sources(["idle"]);
    await sweepIdleSessions(io, 2 * HOUR);
    expect(io.closed).toEqual(["dylan"]);
    expect(io.said).toEqual(['closed idle session s-dylan (tmux "dylan"): off the canvas, quiet for 3.0h']);
  });

  test("leaves a session that started a turn while the sweep was reading", async () => {
    const io = sources(["idle", "busy"]);
    await sweepIdleSessions(io, 2 * HOUR);
    expect(io.closed).toEqual([]);
  });
});
