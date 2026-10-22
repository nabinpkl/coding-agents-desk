import { expect, test } from "bun:test";
import type { AskOwnerCall } from "@agentdesk/agent-feed-wire";
import { readAnswers, readWaitCommand } from "@/asks/askOwnerShape";

const CALL = {
  toolUseId: "toolu_01",
  source: "claude",
  sessionId: "2adc3708-fadb-4e2f-a744-322df224faf4",
  questions: [
    {
      id: "auth",
      question: " Which auth method? ",
      kind: "single",
      options: [{ label: "OAuth", noteLabel: "Why?", preview: "  a\n    b" }, { label: "Passwords" }],
    },
    { id: "name", question: "What should it be called?", kind: "text", options: [] },
  ],
};

const held = (): AskOwnerCall => {
  const read = readWaitCommand(CALL);
  if (!read.ok) throw new Error(read.message);
  return { ...read.value, askedAt: 1 };
};

test("takes a call as written, trimming words and keeping a preview's shape", () => {
  const call = held();
  expect(call.questions[0]!.question).toBe("Which auth method?");
  expect(call.questions[0]!.options[0]).toEqual({ label: "OAuth", noteLabel: "Why?", preview: "  a\n    b" });
  expect(call.questions[1]!.options).toEqual([]);
});

test("refuses a call the panel could not draw or answer", () => {
  const refused = (change: (call: typeof CALL) => unknown) => readWaitCommand(change(structuredClone(CALL)));
  const six = { ...CALL.questions[1]!, id: "x" };
  expect(refused((call) => ({ ...call, questions: [0, 1, 2, 3, 4, 5].map((n) => ({ ...six, id: `q${n}` })) })).ok).toBe(
    false,
  );
  expect(refused((call) => ({ ...call, questions: [CALL.questions[1], CALL.questions[1]] })).ok).toBe(false);
  expect(refused((call) => ({ ...call, questions: [{ ...CALL.questions[1], options: [{ label: "a" }] }] })).ok).toBe(
    false,
  );
  expect(refused((call) => ({ ...call, questions: [{ ...CALL.questions[0], options: [{ label: "a" }] }] })).ok).toBe(
    false,
  );
  expect(
    refused((call) => ({ ...call, questions: [{ ...CALL.questions[0], options: [{ label: "a" }, { label: "a" }] }] }))
      .ok,
  ).toBe(false);
  expect(refused((call) => ({ ...call, source: "codex" })).ok).toBe(false);
  expect(refused((call) => ({ ...call, toolUseId: "../x" })).ok).toBe(false);
  expect(refused((call) => ({ ...call, questions: [{ ...CALL.questions[1], question: "x".repeat(2_001) }] }))).toEqual({
    ok: false,
    message: "questions[0].question is longer than 2000 characters",
  });
});

test("takes answers that fit the call, and keeps a note only where one was written", () => {
  const answers = readAnswers(
    [
      { id: "auth", chosen: [{ label: "OAuth", note: " we use Google " }] },
      { id: "name", chosen: [], text: "Ledger" },
    ],
    held(),
  );
  expect(answers).toEqual({
    ok: true,
    value: [
      { id: "auth", chosen: [{ label: "OAuth", note: "we use Google" }] },
      { id: "name", chosen: [], text: "Ledger" },
    ],
  });
});

test("refuses answers that do not fit the call, naming the first misfit", () => {
  const misfit = (answers: unknown) => {
    const read = readAnswers(answers, held());
    return read.ok ? null : read.message;
  };
  const name = { id: "name", text: "Ledger" };
  expect(misfit([name])).toBe("the call asks 2 questions and 1 answers came");
  expect(misfit([{ id: "other", chosen: [{ label: "OAuth" }] }, name])).toBe('answers[0] answers "other", not "auth"');
  expect(misfit([{ id: "auth", chosen: [{ label: "SSO" }] }, name])).toBe(
    '"SSO" is not an option of "Which auth method?"',
  );
  expect(misfit([{ id: "auth", chosen: [{ label: "OAuth" }, { label: "Passwords" }] }, name])).toBe(
    '"Which auth method?" takes one option',
  );
  expect(misfit([{ id: "auth", chosen: [], text: "  " }, name])).toBe('"Which auth method?" has no answer');
  expect(
    misfit([
      { id: "auth", chosen: [{ label: "OAuth" }] },
      { id: "name", chosen: [{ label: "OAuth" }] },
    ]),
  ).toBe('"What should it be called?" offers no options');
});
