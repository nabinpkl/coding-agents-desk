import { describe, it, expect } from "vitest";
import { openAskUserQuestion, parseAskUserQuestion } from "./askUserQuestion";
import type { ActivityEvent } from "../features/activity-feed/useSessionEventsStream";

function event(
  index: number,
  blocks: ActivityEvent["blocks"],
  extra: Partial<ActivityEvent> = {},
): ActivityEvent {
  return {
    id: `ev-${index}`,
    index,
    revision: 1,
    phase: "complete",
    ts: 1_700_000_000_000 + index,
    type: "assistant",
    blocks,
    ...extra,
  };
}

function toolUse(callId: string, input: Record<string, unknown>): ActivityEvent["blocks"][number] {
  return { kind: "tool_use", tool: "AskUserQuestion", summary: "AskUserQuestion", callId, input };
}

function toolResult(callId: string): ActivityEvent["blocks"][number] {
  return { kind: "tool_result", preview: "answered", callId };
}

const QUESTION_INPUT = {
  questions: [
    {
      question: "Which release identity should the manual deploy of current main use?",
      header: "Release id",
      multiSelect: false,
      options: [
        { label: "Mint 2026-08-08.1 (Recommended)", description: "Add a ledger entry." },
        { label: "Reuse 2026-08-03.1", description: "Deploy immediately." },
        { label: "Don't deploy app code yet", description: "Leave the running release alone." },
      ],
    },
  ],
};

describe("parseAskUserQuestion", () => {
  it("parses the full question from a tool_use input", () => {
    expect(parseAskUserQuestion("toolu_01", QUESTION_INPUT)).toEqual({
      callId: "toolu_01",
      question: "Which release identity should the manual deploy of current main use?",
      header: "Release id",
      multiSelect: false,
      options: [
        { label: "Mint 2026-08-08.1 (Recommended)", description: "Add a ledger entry." },
        { label: "Reuse 2026-08-03.1", description: "Deploy immediately." },
        { label: "Don't deploy app code yet", description: "Leave the running release alone." },
      ],
    });
  });

  it("uses the first question in the array, matching Claude's single-panel UI", () => {
    const input = {
      questions: [
        { question: "First question", options: [{ label: "A" }, { label: "B" }] },
        { question: "Second question", options: [{ label: "C" }] },
      ],
    };
    expect(parseAskUserQuestion("toolu_1", input)?.question).toBe("First question");
  });

  it("reads multiSelect and omits an absent header", () => {
    const parsed = parseAskUserQuestion("toolu_1", {
      questions: [{ question: "Pick features", multiSelect: true, options: [{ label: "Dark" }] }],
    });
    expect(parsed?.multiSelect).toBe(true);
    expect(parsed?.header).toBeUndefined();
  });

  it("returns null without a callId, question text, or usable options", () => {
    expect(parseAskUserQuestion(undefined, QUESTION_INPUT)).toBeNull();
    expect(parseAskUserQuestion("toolu_1", { questions: [] })).toBeNull();
    expect(parseAskUserQuestion("toolu_1", { questions: [{ question: "  " }] })).toBeNull();
    expect(
      parseAskUserQuestion("toolu_1", {
        questions: [{ question: "Q", options: [{ description: "no label" }] }],
      }),
    ).toBeNull();
  });
});

describe("openAskUserQuestion", () => {
  it("returns null when no question is present", () => {
    expect(openAskUserQuestion([], null)).toBeNull();
    expect(
      openAskUserQuestion([event(0, [{ kind: "text", text: "hello" }])], null),
    ).toBeNull();
  });

  it("returns the open question from durable events", () => {
    const events = [event(0, [toolUse("toolu_1", QUESTION_INPUT)])];
    expect(openAskUserQuestion(events, null)?.callId).toBe("toolu_1");
  });

  it("returns null once the matching tool_result arrives", () => {
    const events = [
      event(0, [toolUse("toolu_1", QUESTION_INPUT)]),
      event(1, [toolResult("toolu_1")]),
    ];
    expect(openAskUserQuestion(events, null)).toBeNull();
  });

  it("returns the last open question when several were asked", () => {
    const events = [
      event(0, [toolUse("toolu_1", QUESTION_INPUT)]),
      event(1, [toolResult("toolu_1")]),
      event(2, [toolUse("toolu_2", QUESTION_INPUT)]),
    ];
    expect(openAskUserQuestion(events, null)?.callId).toBe("toolu_2");
  });

  it("keeps the question open when a DIFFERENT tool_result arrives", () => {
    const events = [
      event(0, [toolUse("toolu_1", QUESTION_INPUT)]),
      event(1, [toolResult("toolu_other")]),
    ];
    expect(openAskUserQuestion(events, null)?.callId).toBe("toolu_1");
  });

  it("closes a question carried only by the live tail", () => {
    const tail = event(1, [toolResult("toolu_1")]);
    expect(openAskUserQuestion([event(0, [toolUse("toolu_1", QUESTION_INPUT)])], tail)).toBeNull();
    expect(openAskUserQuestion([event(0, [toolUse("toolu_1", QUESTION_INPUT)])], null)?.callId).toBe(
      "toolu_1",
    );
  });

  it("survives the live tail duplicating a durable event", () => {
    const durable = event(0, [toolUse("toolu_1", QUESTION_INPUT)]);
    const tail = { ...durable, phase: "streaming" as const, revision: 2 };
    expect(openAskUserQuestion([durable], tail)?.callId).toBe("toolu_1");
  });

  it("ignores other tool_use blocks", () => {
    const events = [
      event(0, [{ kind: "tool_use", tool: "Bash", summary: "Bash", callId: "bash_1", input: { command: "ls" } }]),
    ];
    expect(openAskUserQuestion(events, null)).toBeNull();
  });
});
