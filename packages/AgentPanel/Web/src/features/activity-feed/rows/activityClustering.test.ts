import { describe, expect, it } from "vitest";
import {
  clusterLabel,
  isSkillActivation,
  itemKey,
  leadEvent,
} from "@/features/activity-feed/rows/activityDisplayItems";
import { buildFeedLayout } from "@/features/activity-feed/rows/activityFeedLayout";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

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

/** Nice with every run folded, which is the state the fold-all control puts a feed in. */
function foldedLayout(events: ActivityEvent[]) {
  const leads = buildFeedLayout(events, NICE).clusterLeadIds;
  return buildFeedLayout(events, { ...NICE, foldedClusters: new Set(leads) });
}

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

  it("shows a run of tool work as its own rows until the reader folds it", () => {
    nextIndex = 0;
    const events = [
      prose("Starting."),
      call("Read", "Read a.ts"),
      call("Read", "Read b.ts"),
      call("Edit", "Edit a.ts"),
      reasoning("Now the wire."),
      prose("Done."),
    ];

    // Open by default: a line saying `Read ×2, Edit` hid the calls a reader was watching.
    const open = buildFeedLayout(events, NICE);
    expect(open.items.map((item) => item.kind)).toEqual(Array(6).fill("segment_event"));
    expect(open.clusterLeadIds).toEqual([events[1]!.index]);

    const layout = foldedLayout(events);

    // Folded, the run is one row, which is what puts the prose either side of it
    // within a screen.
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

    const layout = foldedLayout(events);

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
    const layout = foldedLayout([call("Bash", "ls"), orphanResult("output"), prose("Done.")]);

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

  it("lists an open run's lead, so fold-all can fold a run that has no cluster row", () => {
    nextIndex = 0;
    const events = [call("Read", "a"), call("Read", "b"), call("Edit", "c")];
    const opened = buildFeedLayout(events, NICE);

    expect(opened.items.map((item) => item.kind)).toEqual([
      "segment_event",
      "segment_event",
      "segment_event",
    ]);
    expect(opened.clusterLeadIds).toEqual([events[0]!.index]);
    expect(foldedLayout(events).clusterLeadIds).toEqual([events[0]!.index]);
  });

  it("keeps a folded run out of the per-row collapse list", () => {
    nextIndex = 0;
    const layout = foldedLayout([call("Read"), call("Read"), prose("Done.")]);

    // A member of a folded run has no row, so it cannot own a collapse toggle.
    expect(layout.allEventIds).toEqual([leadEvent(layout.items[1]!).index]);
    expect(layout.clusterLeadIds).toEqual([leadEvent(layout.items[0]!).index]);
  });

  it("keys a cluster by both ends so a neighbour opening does not re-measure it", () => {
    nextIndex = 0;
    const events = [call("Read"), call("Read"), call("Edit")];
    const layout = foldedLayout(events);

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
