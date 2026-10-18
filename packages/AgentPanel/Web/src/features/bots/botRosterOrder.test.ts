/**
 * What order the roster stands in, asked of the functions rather than of a render.
 *
 * The cases that matter here are the ones a rendered list is awkward to put in: a Bot with no
 * sessions at all, a Bot whose every session is off the canvas, and the same roster with no canvas
 * in the picture, which is what the Bots tab renders.
 */

import { describe, expect, it } from "vitest";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SESSIONS_FOLDED_ABOVE, splitSessionsByCanvas, withOffCanvasLast } from "@/features/bots/botRosterOrder";

const bot = (botId: string, createdAt: number, lastEventAt?: number[]): BotView =>
  ({
    botId,
    name: botId,
    createdAt,
    sessionRefs: [],
    sessions: (lastEventAt ?? []).map((at, index) => ({
      source: "claude",
      sessionId: `${botId}-${index}`,
      title: `${botId} ${index}`,
      lastEventAt: at,
    })),
    missingSessionRefs: [],
    environment: { path: `/Users/dev/${botId}` },
    environmentAvailability: "available",
    metadata: {},
  }) as unknown as BotView;

const ids = (bots: readonly BotView[]) => bots.map((each) => each.botId);
const none = new Set<string>();

describe("withOffCanvasLast", () => {
  const QUIET = bot("quiet", 900);
  const NEWER = bot("newer", 950);
  const BUSY = bot("busy", 100, [50, 5_000]);

  it("leaves a roster alone where every Bot has a card", () => {
    expect(
      ids(
        withOffCanvasLast([QUIET, NEWER, BUSY], {
          detachedBotIds: none,
          machineHiddenBotIds: none,
        }),
      ),
    ).toEqual(["quiet", "newer", "busy"]);
  });

  it("keeps the canvas arrangement among the Bots that have cards", () => {
    // The list arrives in the strip's own left-to-right order, so a reader who moved a card has
    // moved this row with it. Sinking one Bot must not disturb the rest of that.
    expect(
      ids(
        withOffCanvasLast([QUIET, NEWER, BUSY], {
          detachedBotIds: new Set(["newer"]),
          machineHiddenBotIds: none,
        }),
      ),
    ).toEqual(["quiet", "busy", "newer"]);
  });

  it("sinks a Bot on a hidden machine the same way it sinks a detached one", () => {
    expect(
      ids(
        withOffCanvasLast([QUIET, NEWER, BUSY], {
          detachedBotIds: none,
          machineHiddenBotIds: new Set(["quiet"]),
        }),
      ),
    ).toEqual(["newer", "busy", "quiet"]);
  });

  it("reads a sunk Bot's liveliness from its newest session, not from when it was made", () => {
    // `busy` is the oldest of the three by creation and the newest by use: ordering on `createdAt`
    // alone would bury the one Bot here that has been doing anything.
    expect(
      ids(
        withOffCanvasLast([QUIET, NEWER, BUSY], {
          detachedBotIds: new Set(["quiet", "newer", "busy"]),
          machineHiddenBotIds: none,
        }),
      ),
    ).toEqual(["busy", "newer", "quiet"]);
  });

  it("falls back to when a Bot was made, so a new one does not sink under a stale one", () => {
    // Neither has a session, which is the whole of what a just-created Bot can offer.
    expect(
      ids(
        withOffCanvasLast([QUIET, NEWER], {
          detachedBotIds: new Set(["quiet", "newer"]),
          machineHiddenBotIds: none,
        }),
      ),
    ).toEqual(["newer", "quiet"]);
  });

  it("has nothing to sink where there is no canvas to be off", () => {
    const roster = [QUIET, NEWER, BUSY];
    expect(withOffCanvasLast(roster)).toEqual(roster);
  });
});

describe("splitSessionsByCanvas", () => {
  const sessions = (count: number): SessionSummary[] =>
    Array.from(
      { length: count },
      (_, index) =>
        ({
          source: "claude",
          sessionId: `s-${index}`,
          title: `Session ${index}`,
          lastEventAt: index,
        }) as unknown as SessionSummary,
    );

  const off =
    (...ids: string[]) =>
    (session: SessionSummary) =>
      ids.includes(session.sessionId);

  it("puts the sessions with cards first and keeps the Bot's own order inside each group", () => {
    // Not resorted by activity the way a sunk BOT is: a session's place in its Bot survives being
    // taken off the canvas, and it is where the session comes back to.
    const split = splitSessionsByCanvas(sessions(4), off("s-0", "s-2"));
    expect(split.withCard.map((each) => each.sessionId)).toEqual(["s-1", "s-3"]);
    expect(split.withoutCard.map((each) => each.sessionId)).toEqual(["s-0", "s-2"]);
  });

  it("lists a few sessions with no card rather than folding them", () => {
    const split = splitSessionsByCanvas(sessions(4), off("s-0", "s-1", "s-2"));
    expect(split.withoutCard).toHaveLength(SESSIONS_FOLDED_ABOVE);
    expect(split.folded).toBe(false);
  });

  it("folds them once there are more than a few", () => {
    const split = splitSessionsByCanvas(sessions(5), off("s-0", "s-1", "s-2", "s-3"));
    expect(split.folded).toBe(true);
    // Folded is about whether they are DRAWN. They are still split, and still in order.
    expect(split.withoutCard.map((each) => each.sessionId)).toEqual(["s-0", "s-1", "s-2", "s-3"]);
  });

  it("folds a Bot whose every session is off the canvas", () => {
    // What a detached Bot looks like: nothing on the strip, so nothing to leave unfolded.
    const split = splitSessionsByCanvas(sessions(6), () => true);
    expect(split.withCard).toEqual([]);
    expect(split.folded).toBe(true);
  });
});
