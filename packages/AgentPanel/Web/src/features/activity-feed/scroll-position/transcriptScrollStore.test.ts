import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetTranscriptAnchor,
  loadTranscriptAnchor,
  rememberTranscriptAnchor,
} from "@/features/activity-feed/scroll-position/transcriptScrollStore";

const STORAGE_KEY = "agent-panel.transcript-scroll.positions";
const CLAUDE = { source: "claude", sessionId: "sid-a" };
const CODEX = { source: "codex", sessionId: "sid-b" };

describe("where each session was left", () => {
  beforeEach(() => localStorage.clear());

  it("follows the tail until a session has been read away from it", () => {
    expect(loadTranscriptAnchor(CLAUDE)).toBeNull();
  });

  it("keeps a place per session, because two sessions are read in two places at once", () => {
    rememberTranscriptAnchor(CLAUDE, 412);
    rememberTranscriptAnchor(CODEX, 7);
    expect(loadTranscriptAnchor(CLAUDE)).toEqual({ index: 412 });
    expect(loadTranscriptAnchor(CODEX)).toEqual({ index: 7 });
  });

  it("moves a place rather than stacking a second one under the same session", () => {
    rememberTranscriptAnchor(CLAUDE, 412);
    rememberTranscriptAnchor(CLAUDE, 480);
    expect(loadTranscriptAnchor(CLAUDE)).toEqual({ index: 480 });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([["claude:sid-a", 480]]);
  });

  it("forgets a session that reached its end, and writes nothing when none is held", () => {
    rememberTranscriptAnchor(CLAUDE, 412);
    forgetTranscriptAnchor(CLAUDE);
    expect(loadTranscriptAnchor(CLAUDE)).toBeNull();
    // The last entry takes the key with it rather than leaving an empty list behind.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("drops the place read longest ago rather than growing for every session ever opened", () => {
    for (let session = 0; session < 70; session++) {
      rememberTranscriptAnchor({ source: "claude", sessionId: `sid-${session}` }, session);
    }
    expect(loadTranscriptAnchor({ source: "claude", sessionId: "sid-5" })).toBeNull();
    expect(loadTranscriptAnchor({ source: "claude", sessionId: "sid-69" })).toEqual({ index: 69 });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toHaveLength(64);
  });

  it("re-reads before writing, so a second tab's reading is not erased by this one's", () => {
    rememberTranscriptAnchor(CLAUDE, 412);
    // What another tab on this origin did between this tab's last read and its next write.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        ["claude:sid-a", 412],
        ["codex:sid-b", 900],
      ]),
    );
    rememberTranscriptAnchor(CLAUDE, 500);
    expect(loadTranscriptAnchor(CODEX)).toEqual({ index: 900 });
    expect(loadTranscriptAnchor(CLAUDE)).toEqual({ index: 500 });
  });

  it("drops an entry it cannot read rather than scrolling to a place no event has", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        ["claude:sid-a", "412"],
        ["nocolon", 3],
        ["codex:sid-b", 12.5],
        ["claude:sid-c", 8],
      ]),
    );
    expect(loadTranscriptAnchor(CLAUDE)).toBeNull();
    expect(loadTranscriptAnchor(CODEX)).toBeNull();
    expect(loadTranscriptAnchor({ source: "claude", sessionId: "sid-c" })).toEqual({ index: 8 });
  });

  it("keeps the event identity beside the index for a rebuilt projection", () => {
    rememberTranscriptAnchor({ source: "opencode", sessionId: "ses-a" }, 412, "opencode:msg-a");

    expect(loadTranscriptAnchor({ source: "opencode", sessionId: "ses-a" })).toEqual({
      index: 412,
      eventId: "opencode:msg-a",
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([["opencode:ses-a", 412, "opencode:msg-a"]]);
  });

  it("keeps how far into the row the reader was, for one event taller than the viewport", () => {
    rememberTranscriptAnchor({ source: "claude", sessionId: "sid-a" }, 49, "claude:at:49", 878.4);
    rememberTranscriptAnchor({ source: "codex", sessionId: "sid-b" }, 7, undefined, 120);

    expect(loadTranscriptAnchor({ source: "claude", sessionId: "sid-a" })).toEqual({
      index: 49,
      eventId: "claude:at:49",
      offset: 878,
    });
    expect(loadTranscriptAnchor({ source: "codex", sessionId: "sid-b" })).toEqual({ index: 7, offset: 120 });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([
      ["claude:sid-a", 49, "claude:at:49", 878],
      ["codex:sid-b", 7, null, 120],
    ]);
  });

  it("writes a row's own start the short way, and refuses an offset no row could have", () => {
    rememberTranscriptAnchor(CLAUDE, 3, "claude:at:3", 0);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([["claude:sid-a", 3, "claude:at:3"]]);

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        ["claude:sid-a", 3, "claude:at:3", -5],
        ["codex:sid-b", 4, null, 2.5],
        ["claude:sid-c", 5, null, 40],
      ]),
    );
    expect(loadTranscriptAnchor(CLAUDE)).toBeNull();
    expect(loadTranscriptAnchor(CODEX)).toBeNull();
    expect(loadTranscriptAnchor({ source: "claude", sessionId: "sid-c" })).toEqual({ index: 5, offset: 40 });
  });

  it("opens at the tail rather than trusting a value it cannot parse", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadTranscriptAnchor(CLAUDE)).toBeNull();
  });
});
