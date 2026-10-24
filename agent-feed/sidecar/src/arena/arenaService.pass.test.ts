// A pass, against fake drivers: one lane's latest answer goes to a lane of the other stance as its
// next turn, worded by `passText`, in the session it has -- headless or in its pane -- while the run's
// prompt and round stay where they were and no other lane moves.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArenaBadRequestError, ArenaRunBusyError, ArenaService } from "@/arena/arenaService";
import { ArenaRunRegistry } from "@/arena/arenaRun";
import { ArenaStore } from "@/arena/arenaStore";
import type { ContestantDriver } from "@/arena/contestants/contestantDriver";
import { passText } from "@/arena/contestants/laneStance";
import type { ArenaCreateRunRequest } from "@agentdesk/agent-feed-wire";
import type { ActivityEvent } from "@/transcripts/transcriptTypes";
import { until } from "@/testing/until";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const worktrees = {
  async inspectFolder(path: string) {
    return { path, repository: true, problem: null };
  },
  async initRepository() {},
  async add() {},
  async remove() {},
  async prune() {},
  async captureDiff() {
    return "";
  },
};

/** What each lane was sent, in order, with the session it continued and its request id. */
interface Sent {
  lane: string;
  text: string;
  continues: string | undefined;
  requestId: string;
}

/** A turn's events as a harness reports them: the prompt it was given, then what it answered. */
function turn(prompt: string, answer: string): ActivityEvent[] {
  const event = (type: ActivityEvent["type"], value: string, humanTurn = false): ActivityEvent => ({
    id: `${type}:${value}`,
    index: 0,
    revision: 1,
    phase: "complete",
    ts: 1,
    type,
    blocks: [{ kind: "text", text: value }],
    ...(humanTurn ? { humanTurn: true as const } : {}),
  });
  return [event("user", prompt, true), event("assistant", answer)];
}

/**
 * A driver for both modes that answers "<stance> answer <n>" on its nth turn. In the terminals mode
 * it opens its pane once and takes its text from the start line, as the real drivers do.
 */
function answering(sent: Sent[]): ContestantDriver {
  const turns = new Map<string, number>();
  return async (plan) => {
    const lane = plan.worktreePath.split("/").pop()!;
    const session = `session-${lane}`;
    let text = plan.prompt;
    if (plan.terminal) {
      if (!plan.terminal.resume) plan.terminal.onPane(`pane-${lane}`, session);
      text = await plan.terminal.ready();
    } else {
      plan.onSessionId(session);
    }
    sent.push({ lane, text, continues: plan.continues, requestId: plan.requestId });
    const n = (turns.get(lane) ?? 0) + 1;
    turns.set(lane, n);
    return { sessionId: session, events: turn(text, `${plan.stance} answer ${n}`), usage: null };
  };
}

async function arena(drive: ContestantDriver) {
  const created = await mkdtemp(join(tmpdir(), "arena-pass-"));
  roots.push(created);
  const root = await realpath(created);
  const service = new ArenaService({
    registry: new ArenaRunRegistry(),
    store: new ArenaStore(root),
    drivers: { opencode: drive, claude: drive },
    terminalDrivers: { opencode: drive, claude: drive },
    killPane: async () => {},
    worktrees,
    arenaHome: join(root, "home"),
    turnTimeoutMs: 500,
    newRunId: () => "33333333-3333-4333-8333-333333333333",
  });
  return service;
}

const request = (over: Partial<ArenaCreateRunRequest> = {}): ArenaCreateRunRequest => ({
  prompt: "add a cache",
  repoPath: "/repos/one",
  contestants: [{ source: "claude" }, { source: "claude", stance: "against" }],
  ...over,
});

async function settled(service: ArenaService): Promise<void> {
  await until(
    () => service.listRuns()[0]!.contestants.every((c) => c.status === "closed" || c.status === "failed"),
    "every lane to settle",
  );
}

describe.each(["headless", "terminals"] as const)("a pass in the %s mode", (mode) => {
  test("sends the for lane's answer to the against lane, then its critique back, and moves nothing else", async () => {
    const sent: Sent[] = [];
    const service = await arena(answering(sent));
    const run = await service.createRun(request({ mode }));
    await settled(service);
    const [c1, c2] = service.runDetailFor(run.runId)!.contestants;
    expect([c1!.answer, c2!.answer]).toEqual(["for answer 1", "against answer 1"]);

    const passed = service.passAnswer(run.runId, { from: "c1", to: "c2" });
    expect([passed.prompt, passed.round]).toEqual(["add a cache", 1]);
    await settled(service);
    expect(sent.slice(2).map((one) => [one.lane, one.text])).toEqual([["c2", passText(c1!, c2!, "for answer 1")]]);
    expect(service.runDetailFor(run.runId)!.contestants[1]!.answer).toBe("against answer 2");

    service.passAnswer(run.runId, { from: "c2", to: "c1" });
    await settled(service);
    expect(sent.slice(3).map((one) => [one.lane, one.text])).toEqual([["c1", passText(c2!, c1!, "against answer 2")]]);
    // Each turn went into the session the lane already had, under an id no other turn used.
    if (mode === "headless") expect(sent.slice(2).map((one) => one.continues)).toEqual(["session-c2", "session-c1"]);
    expect(new Set(sent.map((one) => one.requestId)).size).toBe(sent.length);
    expect(service.listRuns()[0]!.round).toBe(1);
  });
});

test("a pass is refused between lanes on one side, and waits while any lane is on its turn", async () => {
  const sent: Sent[] = [];
  const service = await arena(answering(sent));
  const run = await service.createRun(
    request({
      mode: "headless",
      contestants: [{ source: "claude" }, { source: "claude" }, { source: "claude", stance: "against" }],
    }),
  );
  expect(() => service.passAnswer(run.runId, { from: "c1", to: "c3" })).toThrow(ArenaRunBusyError);
  await settled(service);
  expect(() => service.passAnswer(run.runId, { from: "c1", to: "c2" })).toThrow(ArenaBadRequestError);
  expect(() => service.passAnswer(run.runId, { from: "c1", to: "c2" })).toThrow(
    "a lane for the prompt and a lane against it",
  );
});
