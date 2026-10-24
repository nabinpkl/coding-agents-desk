// The mark before a session's name that says it was forked or handed over, naming its source.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { BotView, SessionSummary } from "@agentdesk/agent-feed-wire";
import { SessionCardName, sessionOrigin } from "@/features/bots/session-cards/SessionOriginMark";

function session(sessionId: string, title: string): SessionSummary {
  return { sessionId, source: "claude", title, lastEventAt: 1, activity: "ready" } as SessionSummary;
}

const SOURCE = session("source", "Emma (tide pools)");
const FORK = session("fork", "Gina (tide pools)");
const HANDED = session("handed", "Hazel (tide pools)");

function bot(view: Partial<BotView>): BotView {
  return { sessions: [SOURCE, FORK, HANDED], sessionAnchors: { "claude:source": "Emma" }, ...view } as BotView;
}

describe("SessionOriginMark", () => {
  it("marks a fork and a handover before the name, naming the source by its anchor", () => {
    const view = bot({
      sessionOrigins: {
        "claude:fork": { kind: "fork", from: { source: "claude", sessionId: "source" } },
        "claude:handed": { kind: "handover", from: { source: "claude", sessionId: "source" } },
      },
    });
    expect(sessionOrigin(view, FORK)).toEqual({ kind: "fork", text: "Forked from Emma" });
    expect(sessionOrigin(view, HANDED)).toEqual({ kind: "handover", text: "Handed over from Emma" });
    // The source itself was started fresh, so it carries no mark.
    expect(sessionOrigin(view, SOURCE)).toBeUndefined();

    render(<SessionCardName title={FORK.title} origin={sessionOrigin(view, FORK)} />);
    // The title stays the anchor and the task: where it came from is the mark, not more words.
    expect(screen.getByText("Gina (tide pools)")).toBeInTheDocument();
    // Named on hover too, which is how the sidebar's roster, whose row it can be hovered in, says it.
    expect(screen.getByRole("img", { name: "Forked from Emma" }).getAttribute("title")).toBe("Forked from Emma");
  });

  it("falls back to the source's title, then to saying only that there was one", () => {
    const from = (sessionId: string) => ({ kind: "fork" as const, from: { source: "claude" as const, sessionId } });
    const unanchored = bot({ sessionAnchors: {}, sessionOrigins: { "claude:fork": from("source") } });
    expect(sessionOrigin(unanchored, FORK)?.text).toBe("Forked from Emma (tide pools)");
    const gone = bot({ sessionAnchors: {}, sessionOrigins: { "claude:fork": from("long-gone") } });
    expect(sessionOrigin(gone, FORK)?.text).toBe("Forked from another session");
  });

  it("draws the bare name for a session started fresh", () => {
    render(<SessionCardName title="Emma (tide pools)" origin={undefined} />);
    expect(screen.getByText("Emma (tide pools)")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
