import { describe, expect, it } from "vitest";
import type { BotView } from "@agentdesk/agent-feed-wire";
import { botSessionFaces, botSessionMarkNow, sessionOffCanvas } from "@/features/bots/avatar/botSessionFaces";
import {
  botCanvasHues,
  botCanvasRanks,
  botSessionFaceRank,
  botSessionSlots,
  botSessionStyle,
} from "@/features/bots/botSurface";

const bot = (botId: string, createdAt: number, sessionIds: string[]): BotView =>
  ({
    botId,
    name: botId,
    createdAt,
    sessionRefs: sessionIds.map((sessionId) => ({ source: "claude", sessionId })),
    sessions: sessionIds.map((sessionId) => ({
      source: "claude",
      sessionId,
      title: sessionId,
      activity: "live",
      lastEventAt: 1,
    })),
    missingSessionRefs: [],
    environment: { path: `/repo/${botId}` },
    environmentAvailability: "available",
    metadata: {},
  }) as unknown as BotView;

const ALICE = bot("alice", 1, ["a-1", "a-2"]);
const ERICA = bot("erica", 2, ["e-1"]);
const NONE = {
  detachedBotIds: new Set<string>(),
  machineHiddenBotIds: new Set<string>(),
  detachedSessionKeys: new Set<string>(),
};

describe("botSessionFaces", () => {
  it("gives each Bot session the colour and face its roster row and card wear", () => {
    const faces = botSessionFaces([ALICE, ERICA], { ...NONE, openSessionKeys: new Set() });
    const hue = botCanvasHues([ALICE, ERICA]).get("alice")!;
    const rank = botCanvasRanks([ALICE, ERICA]).get("alice")!;
    const step = botSessionSlots(ALICE.sessionRefs, ALICE.sessionSlots).get("claude:a-2")!;
    expect(faces.get("claude:a-2")).toEqual({
      style: botSessionStyle(hue, step),
      rank: botSessionFaceRank(rank, step),
      open: false,
    });
    expect([...faces.keys()]).toEqual(["claude:a-1", "claude:a-2", "claude:e-1"]);
  });

  it("opens the eyes of a session whose card is unfolded", () => {
    const faces = botSessionFaces([ALICE], { ...NONE, openSessionKeys: new Set(["claude:a-1"]) });
    expect(faces.get("claude:a-1")!.open).toBe(true);
    expect(faces.get("claude:a-2")!.open).toBe(false);
  });

  it("leaves a session with no card on the canvas unshaded, by any of the three routes", () => {
    for (const canvas of [
      { ...NONE, detachedSessionKeys: new Set(["claude:a-1"]) },
      { ...NONE, detachedBotIds: new Set(["alice"]) },
      { ...NONE, machineHiddenBotIds: new Set(["alice"]) },
    ]) {
      const face = botSessionFaces([ALICE], { ...canvas, openSessionKeys: new Set() }).get("claude:a-1")!;
      expect(face.style).toBeUndefined();
      expect(face.rank).toBeDefined();
    }
  });

  it("gives a session two Bots hold its first Bot's face", () => {
    const shared = bot("shared", 3, ["a-1"]);
    const faces = botSessionFaces([ALICE, shared], { ...NONE, openSessionKeys: new Set() });
    const alone = botSessionFaces([ALICE], { ...NONE, openSessionKeys: new Set() });
    expect(faces.get("claude:a-1")!.rank).toBe(alone.get("claude:a-1")!.rank);
  });
});

describe("sessionOffCanvas", () => {
  it("is off when the session, its Bot or its Bot's machine is taken off, and on otherwise", () => {
    expect(sessionOffCanvas("alice", "claude:a-1", NONE)).toBe(false);
    expect(sessionOffCanvas("alice", "claude:a-1", { ...NONE, detachedSessionKeys: new Set(["claude:a-1"]) })).toBe(
      true,
    );
    expect(sessionOffCanvas("alice", "claude:a-1", { ...NONE, detachedBotIds: new Set(["alice"]) })).toBe(true);
    expect(sessionOffCanvas("alice", "claude:a-1", { ...NONE, machineHiddenBotIds: new Set(["alice"]) })).toBe(true);
    expect(sessionOffCanvas("alice", "claude:a-1", { ...NONE, detachedBotIds: new Set(["erica"]) })).toBe(false);
  });
});

describe("botSessionMarkNow", () => {
  const faces = botSessionFaces([ALICE], { ...NONE, openSessionKeys: new Set() });

  it("pairs a Bot session's face with its activity as the roster has it now", () => {
    const resting = {
      ...ALICE,
      sessions: ALICE.sessions.map((each) => ({ ...each, activity: "ready" })),
    } as BotView;
    expect(botSessionMarkNow(faces, [ALICE], "claude:a-1")).toEqual({
      face: faces.get("claude:a-1"),
      activity: "live",
    });
    expect(botSessionMarkNow(faces, [resting], "claude:a-1")!.activity).toBe("ready");
  });

  it("has nothing for a session no Bot holds", () => {
    expect(botSessionMarkNow(faces, [ALICE], "claude:elsewhere")).toBeUndefined();
  });
});
