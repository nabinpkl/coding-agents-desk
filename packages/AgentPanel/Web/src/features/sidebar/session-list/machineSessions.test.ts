import { describe, expect, it } from "vitest";
import type { RecentSession, RecentSessionsPayload } from "@agentdesk/agent-feed-wire";
import { mergeRecentSessions } from "@/features/sidebar/session-list/machineSessions";

function row(sessionId: string, lastEventAt: number): RecentSession {
  return {
    source: "claude",
    sessionId,
    title: sessionId,
    lastEventAt,
    activity: "ready",
    projectPath: "/p",
  } as RecentSession;
}

function page(rows: RecentSession[], more = false, reviews: RecentSession[] = [], reviewCount = reviews.length) {
  return {
    recent: rows,
    more,
    securityReviews: { count: reviewCount, live: 0, recent: reviews, more: false },
  } satisfies RecentSessionsPayload;
}

const ids = (rows: readonly RecentSession[]) => rows.map((each) => each.sessionId);

describe("several machines' Sessions lists as one", () => {
  it("waits for the shell's own machine, and is that machine's page alone until a peer answers", () => {
    const mac = page([row("a", 2)]);
    expect(mergeRecentSessions([{ recent: null }, { key: "oracle", recent: page([row("o", 3)]) }], 30, 0)).toBeNull();
    const alone = mergeRecentSessions([{ recent: mac }, { key: "oracle", recent: null }], 30, 0);
    expect(alone?.recent).toBe(mac);
    expect(alone?.machineOf.size).toBe(0);
  });

  it("puts the newest first whichever machine it is on, and says which machine each came from", () => {
    const merged = mergeRecentSessions(
      [
        { recent: page([row("mac-new", 9), row("mac-old", 1)]) },
        { key: "oracle", recent: page([row("oracle-mid", 5)]) },
      ],
      30,
      0,
    )!;
    expect(ids(merged.recent.recent)).toEqual(["mac-new", "oracle-mid", "mac-old"]);
    expect(merged.machineOf.get("claude:oracle-mid")).toBe("oracle");
    expect(merged.machineOf.has("claude:mac-new")).toBe(false);
  });

  it("keeps the machines' order for sessions that changed at the same moment", () => {
    const merged = mergeRecentSessions(
      [{ recent: page([row("mac", 4)]) }, { key: "oracle", recent: page([row("oracle", 4)]) }],
      30,
      0,
    )!;
    expect(ids(merged.recent.recent)).toEqual(["mac", "oracle"]);
  });

  it("cuts at the page, and says there is more when the cut or any machine left some out", () => {
    const merged = mergeRecentSessions(
      [{ recent: page([row("a", 6), row("b", 4)]) }, { key: "oracle", recent: page([row("c", 5), row("d", 3)]) }],
      3,
      0,
    )!;
    expect(ids(merged.recent.recent)).toEqual(["a", "c", "b"]);
    expect(merged.recent.more).toBe(true);

    const peerHasMore = mergeRecentSessions(
      [{ recent: page([row("a", 6)]) }, { key: "oracle", recent: page([row("c", 5)], true) }],
      3,
      0,
    )!;
    expect(peerHasMore.recent.more).toBe(true);
    const allShown = mergeRecentSessions(
      [{ recent: page([row("a", 6)]) }, { key: "oracle", recent: page([row("c", 5)]) }],
      3,
      0,
    )!;
    expect(allShown.recent.more).toBe(false);
  });

  it("counts every machine's security reviews and merges the ones asked for", () => {
    const merged = mergeRecentSessions(
      [
        { recent: page([], false, [row("mac-review", 2)], 4) },
        { key: "oracle", recent: page([], false, [row("oracle-review", 7)], 1) },
      ],
      30,
      1,
    )!;
    expect(merged.recent.securityReviews.count).toBe(5);
    expect(ids(merged.recent.securityReviews.recent)).toEqual(["oracle-review"]);
    expect(merged.recent.securityReviews.more).toBe(true);
    expect(merged.machineOf.get("claude:oracle-review")).toBe("oracle");
  });
});
