import { describe, expect, test } from "bun:test";
import { LiveSessionRegistry } from "@/live/liveSessionRegistry";

function registry(maxSessions: number): LiveSessionRegistry {
  return new LiveSessionRegistry({ vendor: "claude", maxSessions, idleDropMs: 60_000 });
}

describe("the bound on how many sessions a live mirror holds", () => {
  test("evicts the least recently active session", () => {
    const sessions = registry(2);
    sessions.ensure("old");
    sessions.ensure("mid");
    sessions.ensure("new");

    expect(sessions.get("old")).toBeUndefined();
    expect(sessions.get("mid")).toBeDefined();
    expect(sessions.get("new")).toBeDefined();
  });

  test("passes over a session somebody is reading", () => {
    const sessions = registry(2);
    sessions.ensure("watched");
    sessions.retain("watched");
    sessions.ensure("first");
    sessions.ensure("second");

    expect(sessions.get("watched")).toBeDefined();
    expect(sessions.get("first")).toBeUndefined();
    expect(sessions.get("second")).toBeDefined();
  });

  test("evicts the newcomer rather than spinning when what it holds is being read", () => {
    // This test HANGS without the fix. `release` deletes a session's entry rather than leaving a
    // zero behind, so the pass that looked for a zero subscriber count found none and fell through
    // to the oldest session whatever its readers -- here the one being read. `dropSession` then
    // refused to evict it, the size never moved, and the loop chose it again forever.
    const sessions = registry(1);
    sessions.ensure("watched");
    sessions.retain("watched");
    sessions.ensure("newcomer");

    expect(sessions.get("watched")).toBeDefined();
    expect(sessions.get("newcomer")).toBeUndefined();
  });

  test("a session whose last reader left is evictable again", () => {
    const sessions = registry(1);
    sessions.ensure("was-watched");
    sessions.retain("was-watched");
    sessions.release("was-watched");
    sessions.ensure("later");

    expect(sessions.get("was-watched")).toBeUndefined();
    expect(sessions.get("later")).toBeDefined();
  });
});
