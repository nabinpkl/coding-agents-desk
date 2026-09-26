import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@agentdesk/agent-feed-wire";
import { canRenameSession } from "@/features/bots/sessionRename";

function session(source: SessionSummary["source"]): SessionSummary {
  return {
    sessionId: `sid-${source}`,
    source,
    title: "A session",
    lastEventAt: 1,
    activity: "ready",
    capabilities: {
      modes: ["nice"],
      canSend: true,
      canSteer: true,
      canAbort: true,
      canFetchRaw: false,
      canOpenTerminal: false,
      supportsExtensionUi: false,
      canStreamLive: false,
    },
  };
}

describe("canRenameSession", () => {
  it("admits the two sources that carry a title this panel can write", () => {
    expect(canRenameSession(session("claude"))).toBe(true);
    expect(canRenameSession(session("opencode"))).toBe(true);
  });

  // A Codex session's title is a record inside a transcript the panel does not write, so a Rename
  // there could only fail. Absent beats present-and-broken.
  it("refuses a source with no title to write", () => {
    expect(canRenameSession(session("codex"))).toBe(false);
    expect(canRenameSession(session("pi"))).toBe(false);
  });
});
