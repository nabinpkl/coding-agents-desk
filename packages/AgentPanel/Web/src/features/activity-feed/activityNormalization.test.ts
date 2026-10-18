import { describe, expect, it } from "vitest";
import { normalizeActivityEvent } from "@/features/activity-feed/activityNormalization";

describe("normalizeActivityEvent", () => {
  it("preserves supported system blocks and labels", () => {
    expect(
      normalizeActivityEvent({
        index: 4,
        ts: 5,
        type: "system",
        blocks: [{ kind: "metadata", label: "Token Usage", text: "42" }],
      }),
    ).toEqual({
      index: 4,
      ts: 5,
      type: "system",
      // Null, not absent: this function rebuilds the event field by field, so an
      // input without a counterpart index has to come out saying so explicitly.
      otherModeIndex: null,
      blocks: [
        {
          kind: "metadata",
          label: "Token Usage",
          text: "42",
          tool: undefined,
          summary: undefined,
          input: undefined,
          preview: undefined,
          hiddenChars: undefined,
          hiddenLines: undefined,
          callId: undefined,
        },
      ],
    });
  });

  it("turns an unknown installed-dashboard block into Plain", () => {
    const event = normalizeActivityEvent({
      index: 1,
      ts: 2,
      type: "future-role",
      blocks: [{ kind: "future-block", payload: "visible" }],
    });
    expect(event.type).toBe("system");
    expect(event.blocks[0]?.kind).toBe("plain");
    expect(event.blocks[0]?.label).toBe("Plain");
    expect(event.blocks[0]?.text).toContain("future-block");
  });
});
