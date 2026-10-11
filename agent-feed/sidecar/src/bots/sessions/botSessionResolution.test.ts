// What the missing-reference log says, and -- the part that matters more -- what it does not say
// ninety times a minute.
//
// The behaviour under test is the edge trigger and the snapshot scope. `view` runs on every
// catalog broadcast, which is every coalesced transcript write, so a level-triggered log here would
// write a line per reference per write forever; and the held set is process-global, so a per-Bot
// diff would read every other Bot's still-missing reference as resolved. One line on the way in,
// one on the way out, and every pass is a whole snapshot: those are the contracts, and these are
// the tests that hold them. So is the one thing that does NOT make a reference missing, which is
// where the catalog happens to file the session.
//
// The per-Bot scoping test is here because it caught exactly that: it was written against a
// per-Bot note, failed, and the fix was to collect outcomes across the snapshot and note once.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BotRecord, BotSessionRef, SessionSummary } from "@agentdesk/agent-feed-wire";
import {
  forgetMissingBotSessions,
  noteBotSessionOutcomes,
  resolveBotSessions,
  type BotSessionOutcome,
} from "@/bots/sessions/botSessionResolution";
import { state } from "@/transcripts/transcriptState";
import { forgetWorktrees } from "@/git/worktree";

const BOT: BotRecord = {
  botId: "bot-1",
  name: "AD bot",
  environment: { kind: "directory", path: "/repo" },
  sessionRefs: [],
  metadata: { labels: [], custom: {} },
  grants: [],
  createdAt: 0,
  createdBy: { kind: "user" },
};

const REF: BotSessionRef = { source: "claude", sessionId: "sid-1" };
const OTHER_REF: BotSessionRef = { source: "codex", sessionId: "sid-2" };
const OTHER_BOT: BotRecord = { ...BOT, botId: "bot-2", name: "harbor bot" };

type Resolve = (ref: BotSessionRef) => { projectPath: string; summary: SessionSummary } | undefined;
type Split = { sessions: SessionSummary[]; missingSessionRefs: BotSessionRef[] };

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return { sessionId: REF.sessionId, source: "claude", lastEventAt: 0, ...over } as SessionSummary;
}

/** A resolver that answers for the references named, and finds nothing for the rest. */
function resolver(known: Record<string, string>): Resolve {
  return (ref) => {
    const projectPath = known[`${ref.source}:${ref.sessionId}`];
    return projectPath ? { projectPath, summary: summary() } : undefined;
  };
}

function recordWith(...refs: BotSessionRef[]): BotRecord {
  return { ...BOT, sessionRefs: refs };
}

/**
 * One pass over a whole snapshot: resolve every Bot, then note once.
 *
 * Mirrors what `BotRegistry.view` does, and the shape is load-bearing rather than tidy. It returns
 * the splits so a caller can assert on the lists as well as the log.
 */
async function pass(...records: Array<[BotRecord, Resolve]>): Promise<Split[]> {
  const splits = await Promise.all(
    records.map(([record, resolve]) => resolveBotSessions(record, resolve)),
  );
  const outcomes: BotSessionOutcome[] = splits.flatMap((split) => split.outcomes);
  noteBotSessionOutcomes(outcomes);
  return splits;
}

/** One Bot's split, asserted. This tree indexes as possibly undefined, hence the two `!`s. */
async function passOne(record: BotRecord, resolve: Resolve): Promise<Split> {
  const [split] = (await pass([record, resolve]))!;
  return split!;
}

/** The log lines this module wrote, parsed. */
function logged(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((line) => String(line.event ?? "").startsWith("agent-feed-bot-session-"));
}

/** The first log line, asserted. */
function firstLogged(spy: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return logged(spy)[0]!;
}

let log: ReturnType<typeof spyOn>;

beforeEach(() => {
  forgetMissingBotSessions();
  forgetWorktrees();
  state.sessions.clear();
  state.watcherState = "live";
  log = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  log.mockRestore();
  state.sessions.clear();
  forgetMissingBotSessions();
});

describe("a reference that resolves", () => {
  test("is put in `sessions` and says nothing", async () => {
    const split = await passOne(recordWith(REF), resolver({ "claude:sid-1": "/repo" }));
    expect(split.sessions).toHaveLength(1);
    expect(split.missingSessionRefs).toEqual([]);
    expect(logged(log)).toEqual([]);
  });
});

describe("a reference the catalog does not hold", () => {
  test("is `missing`, and the line says the catalog had nothing", async () => {
    const split = await passOne(recordWith(REF), resolver({}));
    expect(split.missingSessionRefs).toEqual([REF]);
    const line = firstLogged(log);
    expect(line.event).toBe("agent-feed-bot-session-missing");
    expect(line.sessionId).toBe("sid-1");
    expect(line.botPath).toBe("/repo");
  });

  test("carries the catalog's size, which is the field that names a restart", async () => {
    state.watcherState = "reconciling";
    await passOne(recordWith(REF), resolver({}));
    const line = firstLogged(log);
    expect(line.catalogSessions).toBe(0);
    expect(line.catalogState).toBe("reconciling");
  });
});

describe("a reference the catalog files somewhere else", () => {
  test("is shown, because the reference is the fact and the directory was checked on attach", async () => {
    // The renamed-project case: the catalog files the session wherever its agent last ran a
    // command, which changed 81 times in 2,064 writes on the session that prompted this.
    const split = await passOne(recordWith(REF), resolver({ "claude:sid-1": "/scratchpad" }));
    expect(split.sessions).toHaveLength(1);
    expect(split.missingSessionRefs).toEqual([]);
    expect(logged(log)).toEqual([]);
  });

  test("moving between directories never flips it, which is the whole point", async () => {
    for (const where of ["/repo", "/scratchpad", "/repo/backend", "/elsewhere", "/repo"]) {
      const split = await passOne(recordWith(REF), resolver({ "claude:sid-1": where }));
      expect(split.missingSessionRefs).toEqual([]);
    }
    expect(logged(log)).toEqual([]);
  });
});

describe("the edge trigger", () => {
  test("says nothing on the next passes while it stays missing", async () => {
    await passOne(recordWith(REF), resolver({}));
    expect(logged(log)).toHaveLength(1);
    log.mockClear();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await passOne(recordWith(REF), resolver({}));
    }
    // The whole point: this is the path that would have produced a line per write, forever.
    expect(logged(log)).toEqual([]);
  });

  test("says nothing for a reference on ANOTHER Bot that is also missing", async () => {
    // The bug this file was written for. The held set is process-global, so a per-Bot diff calls
    // every other Bot's still-missing reference resolved -- one false line per Bot per broadcast.
    await pass([recordWith(REF), resolver({})], [recordWith(OTHER_REF), resolver({})]);
    expect(logged(log)).toHaveLength(2);
    log.mockClear();
    await pass([recordWith(REF), resolver({})], [recordWith(OTHER_REF), resolver({})]);
    expect(logged(log)).toEqual([]);
  });
});

describe("coming back", () => {
  test("says it resolved, and how long it was gone", async () => {
    await passOne(recordWith(REF), resolver({}));
    log.mockClear();
    const split = await passOne(recordWith(REF), resolver({ "claude:sid-1": "/repo" }));
    expect(split.sessions).toHaveLength(1);
    const line = firstLogged(log);
    expect(line.event).toBe("agent-feed-bot-session-resolved");
    expect(typeof line.missingForMs).toBe("number");
    expect(line.sessionId).toBe("sid-1");
  });

  test("a reference detached from the Bot is a resolution, not a silence", async () => {
    // Otherwise removing a session that was already missing leaves a held entry forever, and the
    // next Bot to hold the same reference inherits its duration.
    await passOne(recordWith(REF), resolver({}));
    log.mockClear();
    await passOne(recordWith(), resolver({}));
    const line = firstLogged(log);
    expect(line.event).toBe("agent-feed-bot-session-resolved");
    expect(line.sessionId).toBe("sid-1");
  });
});

describe("an archived session", () => {
  test("is left out of the Bot view entirely, neither shown nor missing", async () => {
    const split = await resolveBotSessions(recordWith(REF, OTHER_REF), (ref) =>
      ref.sessionId === REF.sessionId
        ? { projectPath: "/repo", summary: summary({ archivedAt: 1_000 }) }
        : { projectPath: "/repo", summary: summary({ sessionId: OTHER_REF.sessionId, source: "codex" }) });
    expect(split.sessions.map((session) => session.sessionId)).toEqual([OTHER_REF.sessionId]);
    expect(split.missingSessionRefs).toEqual([]);
  });
});
