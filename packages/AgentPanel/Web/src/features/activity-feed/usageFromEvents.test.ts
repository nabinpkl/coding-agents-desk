import { describe, expect, it } from "vitest";
import { lastUsageFromEvents, parseUsageText } from "@/features/activity-feed/usageFromEvents";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

function event(index: number, blocks: ActivityEvent["blocks"], ts = 1000 + index): ActivityEvent {
  return { index, id: `e-${index}`, revision: 0, phase: "complete", ts, type: "assistant", blocks };
}

const tokenUsage = (text: string): ActivityEvent["blocks"] => [{ kind: "metadata", label: "Token Usage", text }];

describe("parseUsageText", () => {
  it("parses Claude's current-only rendering", () => {
    expect(parseUsageText("71,411 tokens")).toEqual({ current: 71_411, limit: null });
    expect(parseUsageText("812 tokens")).toEqual({ current: 812, limit: null });
  });

  it("parses Codex's current-and-window rendering", () => {
    expect(parseUsageText("1,234 / 200,000 tokens")).toEqual({
      current: 1_234,
      limit: 200_000,
    });
  });

  it("is immune to digit grouping style", () => {
    expect(parseUsageText("71 411 tokens")).toEqual({ current: 71_411, limit: null });
    expect(parseUsageText("1234 / 200000 tokens")).toEqual({
      current: 1_234,
      limit: 200_000,
    });
  });

  it("rejects anything that is not a token reading", () => {
    expect(parseUsageText("Working Directory")).toBeNull();
    expect(parseUsageText("Stop Reason")).toBeNull();
    expect(parseUsageText("71,411 tokens and more")).toBeNull();
    expect(parseUsageText("")).toBeNull();
  });

  it("rejects a nonpositive window", () => {
    expect(parseUsageText("1,234 / 0 tokens")).toBeNull();
  });
});

describe("lastUsageFromEvents", () => {
  it("takes the newest usage-bearing entry", () => {
    const events = [event(0, tokenUsage("40,000 tokens"), 1000), event(1, tokenUsage("52,000 tokens"), 2000)];
    expect(lastUsageFromEvents(events)).toEqual({
      current: 52_000,
      limit: null,
      updatedAt: 2000,
    });
  });

  it("skips non-usage blocks and returns null when none carry usage", () => {
    const events = [
      event(0, [{ kind: "metadata", label: "Working Directory", text: "/repo" }]),
      event(1, [{ kind: "text", text: "hello" }]),
    ];
    expect(lastUsageFromEvents(events)).toBeNull();
    expect(lastUsageFromEvents([])).toBeNull();
  });

  it("uses the reading from the last event that has one, even if a later event lacks it", () => {
    const events = [
      event(0, tokenUsage("40,000 tokens"), 1000),
      event(1, [{ kind: "text", text: "no usage here" }], 2000),
    ];
    expect(lastUsageFromEvents(events)).toEqual({
      current: 40_000,
      limit: null,
      updatedAt: 1000,
    });
  });
});
