import { describe, expect, it } from "vitest";
import {
  clusterLabel,
  isSkillActivation,
  itemKey,
  leadEvent,
} from "./activityDisplayItems";
import { buildFeedLayout } from "./activityFeedLayout";
import type { ActivityEvent } from "./useSessionEventsStream";

let nextIndex = 0;
function call(tool: string, summary = ""): ActivityEvent {
  return {
    index: nextIndex++,
    ts: 1,
    type: "assistant",
    blocks: [{ kind: "tool_use", tool, summary, callId: `call-${nextIndex}` }],
  };
}
function prose(text: string): ActivityEvent {
  return { index: nextIndex++, ts: 1, type: "assistant", blocks: [{ kind: "text", text }] };
}
function reasoning(text: string): ActivityEvent {
  return { index: nextIndex++, ts: 1, type: "reasoning", blocks: [{ kind: "reasoning", text }] };
}
function system(text: string): ActivityEvent {
  return { index: nextIndex++, ts: 1, type: "system", blocks: [{ kind: "text", text }] };
}
function orphanResult(preview: string): ActivityEvent {
  return {
    index: nextIndex++,
    ts: 1,
    type: "user",
    blocks: [{ kind: "tool_result", preview, callId: "call-missing" }],
  };
}

const NICE = { cluster: true, hideSystem: true, incrementalReasoning: true } as const;

describe("nice-mode clustering", () => {
  it("renders only the suffix added by cumulative Codex reasoning snapshots", () => {
    nextIndex = 0;
    const events = [
      reasoning("**Designing diagnostics**"),
      system("item completed"),
      reasoning("**Designing diagnostics**\n\n**Defining sampling**"),
      system("item completed"),
      reasoning(
        "**Designing diagnostics**\n\n**Defining sampling**\n\n**Adding repair metrics**",
      ),
      reasoning(
        "**Designing diagnostics**\n\n**Defining sampling**\n\n**Adding repair metrics**",
      ),
    ];

    const niceReasoning = buildFeedLayout(events, NICE).items
      .map(leadEvent)
      .flatMap((event) => event.blocks)
      .filter((block) => block.kind === "reasoning")
      .map((block) => block.text);

    expect(niceReasoning).toEqual([
      "**Designing diagnostics**",
      "**Defining sampling**",
      "**Adding repair metrics**",
    ]);

    const rawReasoning = buildFeedLayout(events).items
      .map(leadEvent)
      .flatMap((event) => event.blocks)
      .filter((block) => block.kind === "reasoning")
      .map((block) => block.text);
    expect(rawReasoning[1]).toBe("**Designing diagnostics**\n\n**Defining sampling**");
  });

  it("removes System rows while Raw keeps the transcript line", () => {
    nextIndex = 0;
    const events = [system("session initialized"), prose("Ready")];

    expect(buildFeedLayout(events, NICE).items.map(leadEvent).map((event) => event.type))
      .toEqual(["assistant"]);
    expect(buildFeedLayout(events).items.map(leadEvent).map((event) => event.type))
      .toEqual(["system", "assistant"]);
  });

  it("folds a run of tool work and leaves prose and reasoning alone", () => {
    nextIndex = 0;
    const events = [
      prose("Starting."),
      call("Read", "Read a.ts"),
      call("Read", "Read b.ts"),
      call("Edit", "Edit a.ts"),
      reasoning("Now the wire."),
      prose("Done."),
    ];

    const layout = buildFeedLayout(events, NICE);

    // Tool work is 54 of every 100 rows in this project's largest Codex session and
    // almost none of it is what a viewer scrolling back is looking for. One row for
    // the run is what puts the prose either side of it within a screen.
    expect(layout.items.map((item) => item.kind)).toEqual([
      "segment_event",
      "cluster",
      "segment_event",
      "segment_event",
    ]);
    const cluster = layout.items[1]!;
    expect(cluster.kind === "cluster" && cluster.events.length).toBe(3);
  });

  it("leaves a run of one alone, because folding one row saves nothing", () => {
    nextIndex = 0;
    const layout = buildFeedLayout([prose("a"), call("Read"), prose("b")], NICE);

    expect(layout.items.map((item) => item.kind)).toEqual([
      "segment_event",
      "segment_event",
      "segment_event",
    ]);
  });

  it("never folds a skill activation or a delegation", () => {
    nextIndex = 0;
    const events = [
      call("Read", "Read a.ts"),
      call("Skill", "Skill codebase-onboarding"),
      call("Read", "Read b.ts"),
      call("Read", "Read c.ts"),
    ];

    const layout = buildFeedLayout(events, NICE);

    // A skill activation changes what the agent is doing. Folding it into "3 steps"
    // would hide the one line that explains the next twenty.
    expect(layout.items.map((item) => item.kind)).toEqual([
      "segment_event",
      "segment_event",
      "cluster",
    ]);
    expect(layout.items[1]!.kind === "segment_event" &&
      layout.items[1]!.ev.blocks[0]?.summary).toBe("Skill codebase-onboarding");
  });

  it("detects a codex skill activation from the truncated summary", () => {
    // Codex activates a skill by READING its SKILL.md through a shell call, and
    // 3,123 of the 3,322 such calls across this project's rollouts (94%) name the
    // path inside the 200 characters the summary keeps -- which is why this works
    // from the summary the phone also receives, with no untruncated input needed.
    expect(isSkillActivation(
      call("exec_command", "cat /Users/dev/.agents/skills/taste/SKILL.md"),
    )).toBe(true);
    expect(isSkillActivation(call("exec_command", "cat README.md"))).toBe(false);
  });

  it("clusters unpaired results alongside calls, and never prose", () => {
    nextIndex = 0;
    const layout = buildFeedLayout(
      [call("Bash", "ls"), orphanResult("output"), prose("Done.")],
      NICE,
    );

    expect(layout.items.map((item) => item.kind)).toEqual(["cluster", "segment_event"]);
  });

  it("stays flat in the raw view, which is the fidelity guarantee", () => {
    nextIndex = 0;
    const events = [call("Read"), call("Read"), call("Edit")];

    // No options means no clustering, so the raw view keeps one row per line and the
    // virtualizer's one-event-per-row model intact there.
    expect(buildFeedLayout(events).items.map((item) => item.kind)).toEqual([
      "segment_event",
      "segment_event",
      "segment_event",
    ]);
  });

  it("expands a cluster back into its rows when the viewer opens it", () => {
    nextIndex = 0;
    const events = [call("Read", "a"), call("Read", "b"), call("Edit", "c")];
    const folded = buildFeedLayout(events, NICE);
    const lead = leadEvent(folded.items[0]!).index;

    const opened = buildFeedLayout(events, {
      cluster: true,
      expandedClusters: new Set([lead]),
    });

    expect(opened.items.map((item) => item.kind)).toEqual([
      "segment_event",
      "segment_event",
      "segment_event",
    ]);
    // The fold-all control has to be able to close what was just opened, so an open
    // cluster's lead stays listed even though no cluster row exists for it.
    expect(opened.clusterLeadIds).toContain(lead);
  });

  it("keeps a folded run out of the per-row collapse list", () => {
    nextIndex = 0;
    const layout = buildFeedLayout([call("Read"), call("Read"), prose("Done.")], NICE);

    // A member of a folded run has no row, so it cannot own a collapse toggle.
    expect(layout.allEventIds).toEqual([leadEvent(layout.items[1]!).index]);
    expect(layout.clusterLeadIds).toEqual([leadEvent(layout.items[0]!).index]);
  });

  it("keys a cluster by both ends so a neighbour opening does not re-measure it", () => {
    nextIndex = 0;
    const events = [call("Read"), call("Read"), call("Edit")];
    const layout = buildFeedLayout(events, NICE);

    expect(itemKey(layout.items[0]!)).toBe("cluster-0-2");
  });
});

describe("clusterLabel", () => {
  it("names the tools and their counts", () => {
    nextIndex = 0;
    expect(clusterLabel([
      call("Bash"), call("Bash"), call("Bash"), call("Bash"),
      call("Edit"), call("Edit"), call("Read"),
    ])).toBe("7 steps · Bash ×4, Edit ×2, Read");
  });

  it("falls back to a bare count when nothing names a tool", () => {
    nextIndex = 0;
    expect(clusterLabel([orphanResult("a"), orphanResult("b")])).toBe("2 steps");
  });

  it("caps the named tools so one row cannot stretch", () => {
    nextIndex = 0;
    const label = clusterLabel([
      call("A"), call("B"), call("C"), call("D"), call("E"), call("F"),
    ]);
    expect(label).toBe("6 steps · A, B, C, D");
  });
});
