import { describe, expect, it } from "vitest";
import type { BotSessionRef, BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { FIXTURE_SESSIONS } from "@/app/fake-sidecar/fixtureData";
import { botsOnBranches, branchesWithSession } from "@/features/branches/branchBots";

function bot(botId: string, sessions: SessionSummary[], extra: Partial<BotView> = {}): BotView {
  return {
    botId,
    name: botId,
    environment: { kind: "directory", path: "/projects/a" },
    sessionRefs: sessions.map(({ source, sessionId }) => ({ source, sessionId })),
    metadata: { labels: [], custom: {} },
    grants: [],
    createdAt: 1,
    createdBy: { kind: "user" },
    environmentAvailability: "available",
    sessions,
    missingSessionRefs: [],
    nextAnchor: "Ada",
    ...extra,
  };
}

describe("botsOnBranches", () => {
  const [first, second] = [FIXTURE_SESSIONS[0]!, FIXTURE_SESSIONS[1]!];

  it("keeps only the Bots marked for Branches, each with only its marked sessions", () => {
    const marked = bot("marked", [first, second], {
      canvases: { branches: { sessionRefs: [{ source: second.source, sessionId: second.sessionId }] } },
    });
    const shown = botsOnBranches([bot("unmarked", [first]), marked]);
    expect(shown.map((each) => each.botId)).toEqual(["marked"]);
    expect(shown[0]!.sessions.map((each) => each.sessionId)).toEqual([second.sessionId]);
    // The record's own list stays whole: a card's commands are about every session the Bot holds.
    expect(shown[0]!.sessionRefs).toHaveLength(2);
  });

  it("shows a marked Bot with no sessions listed as a Bot with none", () => {
    const shown = botsOnBranches([bot("bare", [first], { canvases: { branches: { sessionRefs: [] } } })]);
    expect(shown[0]!.sessions).toEqual([]);
  });
});

describe("branchesWithSession", () => {
  const listed: BotSessionRef = { source: "claude", sessionId: "listed" };
  const started: BotSessionRef = { source: "claude", sessionId: "started" };

  it("adds a session started on Branches after the ones its Bot already lists there", () => {
    const onBranches = bot("b", [], { canvases: { branches: { sessionRefs: [listed] } } });
    expect(branchesWithSession(onBranches, started)).toEqual({ canvases: { branches: [listed, started] } });
  });

  it("asks for nothing when the Bot is not on Branches or already lists the session", () => {
    expect(branchesWithSession(bot("b", []), started)).toBeNull();
    const already = bot("b", [], { canvases: { branches: { sessionRefs: [listed, started] } } });
    expect(branchesWithSession(already, started)).toBeNull();
  });
});
