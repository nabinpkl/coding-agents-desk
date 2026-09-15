import { describe, it, expect } from "vitest";
import { openAskUserQuestion, parseAskUserQuestion } from "@/app/askUserQuestion";
import type { ActivityEvent } from "@/features/activity-feed/useSessionEventsStream";

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
      questions: [{
        question: "Which release identity should the manual deploy of current main use?",
        header: "Release id",
        multiSelect: false,
        options: [
          { label: "Mint 2026-08-08.1 (Recommended)", description: "Add a ledger entry." },
          { label: "Reuse 2026-08-03.1", description: "Deploy immediately." },
          { label: "Don't deploy app code yet", description: "Leave the running release alone." },
        ],
      }],
    });
  });

  it("keeps every question, in the order the answers are matched by", () => {
    const input = {
      questions: [
        { question: "First question", options: [{ label: "A" }, { label: "B" }] },
        { question: "Second question", options: [{ label: "C" }] },
      ],
    };
    // Taking only the first is what the Desktop panel's single-pane UI wanted. The terminal
    // dialog draws a tab per question and will not submit until each has an answer.
    expect(parseAskUserQuestion("toolu_1", input)?.questions.map((entry) => entry.question))
      .toEqual(["First question", "Second question"]);
  });

  it("reads multiSelect and omits an absent header", () => {
    const parsed = parseAskUserQuestion("toolu_1", {
      questions: [{ question: "Pick features", multiSelect: true, options: [{ label: "Dark" }] }],
    });
    expect(parsed?.questions[0]?.multiSelect).toBe(true);
    expect(parsed?.questions[0]?.header).toBeUndefined();
  });

  it("keeps an option preview as written, because its shape is the content", () => {
    const parsed = parseAskUserQuestion("toolu_1", {
      questions: [{
        question: "Which layout?",
        options: [{ label: "Split", preview: "left | right\n  a  |  b" }, { label: "Stacked" }],
      }],
    });
    expect(parsed?.questions[0]?.options[0]?.preview).toBe("left | right\n  a  |  b");
    expect(parsed?.questions[0]?.options[1]?.preview).toBeUndefined();
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

  it("returns null when ONE question of several is unusable", () => {
    // Dropping it would leave the answers one short and every answer after it matched against the
    // wrong question, which the dialog cannot detect and neither could a reader.
    expect(parseAskUserQuestion("toolu_1", {
      questions: [
        { question: "Fine", options: [{ label: "A" }] },
        { question: "Broken", options: [] },
        { question: "Also fine", options: [{ label: "B" }] },
      ],
    })).toBeNull();
  });
});

describe("openAskUserQuestion", () => {
  it("returns null when no question is present", () => {
    expect(openAskUserQuestion([], [])).toBeNull();
    expect(
      openAskUserQuestion([event(0, [{ kind: "text", text: "hello" }])], []),
    ).toBeNull();
  });

  it("returns the open question from durable events", () => {
    const events = [event(0, [toolUse("toolu_1", QUESTION_INPUT)])];
    expect(openAskUserQuestion(events, [])?.callId).toBe("toolu_1");
  });

  it("returns null once the matching tool_result arrives", () => {
    const events = [
      event(0, [toolUse("toolu_1", QUESTION_INPUT)]),
      event(1, [toolResult("toolu_1")]),
    ];
    expect(openAskUserQuestion(events, [])).toBeNull();
  });

  it("returns the last open question when several were asked", () => {
    const events = [
      event(0, [toolUse("toolu_1", QUESTION_INPUT)]),
      event(1, [toolResult("toolu_1")]),
      event(2, [toolUse("toolu_2", QUESTION_INPUT)]),
    ];
    expect(openAskUserQuestion(events, [])?.callId).toBe("toolu_2");
  });

  it("keeps the question open when a DIFFERENT tool_result arrives", () => {
    const events = [
      event(0, [toolUse("toolu_1", QUESTION_INPUT)]),
      event(1, [toolResult("toolu_other")]),
    ];
    expect(openAskUserQuestion(events, [])?.callId).toBe("toolu_1");
  });

  it("closes a question carried only by the live tail", () => {
    const tail = event(1, [toolResult("toolu_1")]);
    expect(openAskUserQuestion([event(0, [toolUse("toolu_1", QUESTION_INPUT)])], [tail])).toBeNull();
    expect(openAskUserQuestion([event(0, [toolUse("toolu_1", QUESTION_INPUT)])], [])?.callId).toBe(
      "toolu_1",
    );
  });

  it("survives the live tail duplicating a durable event", () => {
    const durable = event(0, [toolUse("toolu_1", QUESTION_INPUT)]);
    const tail = { ...durable, phase: "streaming" as const, revision: 2 };
    expect(openAskUserQuestion([durable], [tail])?.callId).toBe("toolu_1");
  });

  it("closes a question the reader answered by typing something else instead", () => {
    // The shape measured in a real transcript on 2026-09-15: the call gets no tool_result ever,
    // the person's own message follows it, and the session carries on underneath a mirror that
    // used to stay up for good.
    const events = [
      event(0, [toolUse("toolu_1", QUESTION_INPUT)], { messageId: "msg_asked" }),
      event(1, [{ kind: "text", text: "continue no edit" }], { type: "user", humanTurn: true }),
      event(2, [{ kind: "text", text: "Following the thread" }], { messageId: "msg_after" }),
    ];
    expect(openAskUserQuestion(events, [])).toBeNull();
  });

  it("closes a question the turn moved past without ever answering it", () => {
    const events = [
      event(0, [toolUse("toolu_1", QUESTION_INPUT)], { messageId: "msg_asked" }),
      event(1, [{ kind: "reasoning", text: "on to the next thing" }], {
        type: "reasoning",
        messageId: "msg_after",
      }),
    ];
    expect(openAskUserQuestion(events, [])).toBeNull();
  });

  it("keeps the question open while its OWN message writes its other lines", () => {
    // A call batched alongside this one writes a line from the same message, and a result for that
    // call arrives while this question is still standing. Neither is the turn moving anywhere.
    const events = [
      event(0, [toolUse("toolu_1", QUESTION_INPUT)], { messageId: "msg_asked" }),
      event(1, [{ kind: "tool_use", tool: "Bash", summary: "Bash", callId: "bash_1", input: {} }], {
        messageId: "msg_asked",
      }),
      event(2, [toolResult("bash_1")], { type: "user" }),
    ];
    expect(openAskUserQuestion(events, [])?.callId).toBe("toolu_1");
  });

  it("keeps the question open while the live tail republishes the message that asked it", () => {
    // The tail IS the turn that asked, so its rows are never evidence the turn moved on -- even
    // the ones the mirror publishes with no message id at all.
    const durable = event(0, [toolUse("toolu_1", QUESTION_INPUT)], { messageId: "msg_asked" });
    const tail = [
      event(1, [{ kind: "text", text: "thinking out loud" }], { phase: "streaming" }),
      { ...durable, index: 2, phase: "streaming" as const },
    ];
    expect(openAskUserQuestion([durable], tail)?.callId).toBe("toolu_1");
  });

  it("does not let the live tail reopen a question the transcript already closed", () => {
    const durable = event(0, [toolUse("toolu_1", QUESTION_INPUT)], { messageId: "msg_asked" });
    const events = [durable, event(1, [toolResult("toolu_1")], { type: "user" })];
    expect(openAskUserQuestion(events, [{ ...durable, index: 2 }])).toBeNull();
  });

  it("ignores other tool_use blocks", () => {
    const events = [
      event(0, [{ kind: "tool_use", tool: "Bash", summary: "Bash", callId: "bash_1", input: { command: "ls" } }]),
    ];
    expect(openAskUserQuestion(events, [])).toBeNull();
  });
});
