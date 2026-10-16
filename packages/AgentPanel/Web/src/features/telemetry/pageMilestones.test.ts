// The page load is held open for exactly what the page is going to show, and no longer: a hold that
// waits for something that never comes costs every such load the whole limit.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ended = vi.fn();
vi.mock("@sentry/react", () => ({ startInactiveSpan: vi.fn(() => ({ end: ended })) }));

const {
  awaitMilestones,
  expectMilestone,
  measureStreamFirstMessage,
  reachMilestone,
  resetMilestones,
} = await import("@/features/telemetry/pageMilestones");

const measures = () => performance.getEntriesByType("measure").map((entry) => entry.name);

describe("page milestones", () => {
  beforeEach(() => {
    resetMilestones();
    ended.mockClear();
    performance.clearMeasures();
  });
  afterEach(() => performance.clearMeasures());

  it("ends the hold once the awaited milestone is reached, and measures it from the page's start", () => {
    awaitMilestones(["first-card"]);
    expect(ended).not.toHaveBeenCalled();
    reachMilestone("first-card");
    expect(ended).toHaveBeenCalledTimes(1);
    expect(measures()).toEqual(["panel first-card"]);
    expect(performance.getEntriesByName("panel first-card")[0]!.startTime).toBe(0);
  });

  it("waits for rows too once a transcript has said it is coming", () => {
    awaitMilestones(["first-card"]);
    expectMilestone("first-rows");
    reachMilestone("first-card");
    expect(ended).not.toHaveBeenCalled();
    reachMilestone("first-rows");
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("does not reopen a hold that has ended, nor measure a milestone twice", () => {
    awaitMilestones(["first-card"]);
    reachMilestone("first-card");
    expectMilestone("first-rows");
    reachMilestone("first-card");
    expect(ended).toHaveBeenCalledTimes(1);
    expect(measures()).toEqual(["panel first-card"]);
  });

  it("measures each stream's first message once, named by its path without the query", () => {
    measureStreamFirstMessage("/api/inventory/stream?project=a", 0);
    measureStreamFirstMessage("/api/inventory/stream?project=b", 0);
    measureStreamFirstMessage("/api/bots/stream", 0);
    expect(measures()).toEqual(["stream /api/inventory/stream", "stream /api/bots/stream"]);
  });
});
