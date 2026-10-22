import { describe, expect, it } from "vitest";
import type { AskOwnerQuestion } from "@agentdesk/agent-feed-wire";
import {
  chooseOption,
  emptyDrafts,
  isAnswered,
  toAnswers,
  writeNote,
  writeText,
} from "@/features/session-view/composer/ask-owner/askOwnerDrafts";

const SINGLE: AskOwnerQuestion = {
  id: "auth",
  question: "Which auth method?",
  kind: "single",
  options: [{ label: "OAuth", noteLabel: "Why?" }, { label: "Passwords" }],
};
const MULTI: AskOwnerQuestion = {
  id: "scope",
  question: "Which scopes?",
  kind: "multi",
  options: [{ label: "Read" }, { label: "Write" }],
};
const TEXT: AskOwnerQuestion = { id: "name", question: "What should it be called?", kind: "text", options: [] };
const QUESTIONS = [SINGLE, MULTI, TEXT];

describe("ask_owner drafts", () => {
  it("lets a single question hold one option or words, never both", () => {
    let drafts = chooseOption(emptyDrafts(QUESTIONS), 0, 0, SINGLE);
    expect(drafts[0]!.chosen).toEqual([0]);
    drafts = writeText(drafts, 0, "SSO through the company", SINGLE);
    expect(drafts[0]).toMatchObject({ chosen: [], text: "SSO through the company" });
    drafts = chooseOption(drafts, 0, 1, SINGLE);
    expect(drafts[0]).toMatchObject({ chosen: [1], text: "" });
    // Picking the chosen option again lets it go.
    expect(chooseOption(drafts, 0, 1, SINGLE)[0]!.chosen).toEqual([]);
  });

  it("lets a multi question hold several options and words side by side", () => {
    let drafts = chooseOption(emptyDrafts(QUESTIONS), 1, 1, MULTI);
    drafts = chooseOption(drafts, 1, 0, MULTI);
    drafts = writeText(drafts, 1, "and admin", MULTI);
    expect(drafts[1]).toMatchObject({ chosen: [1, 0], text: "and admin" });
    expect(chooseOption(drafts, 1, 1, MULTI)[1]!.chosen).toEqual([0]);
  });

  it("keeps a note through unpicking, and sends only a chosen option's", () => {
    let drafts = chooseOption(emptyDrafts(QUESTIONS), 0, 0, SINGLE);
    drafts = writeNote(drafts, 0, 0, "  we already use Google  ");
    drafts = chooseOption(drafts, 0, 1, SINGLE);
    expect(drafts[0]!.notes[0]).toBe("  we already use Google  ");
    drafts = chooseOption(drafts, 0, 0, SINGLE);
    drafts = chooseOption(drafts, 1, 0, MULTI);
    drafts = writeText(drafts, 2, " Ledger ", TEXT);
    expect(toAnswers(QUESTIONS, drafts)).toEqual([
      { id: "auth", chosen: [{ label: "OAuth", note: "we already use Google" }] },
      { id: "scope", chosen: [{ label: "Read" }] },
      { id: "name", chosen: [], text: "Ledger" },
    ]);
  });

  it("sends nothing while a question has no answer", () => {
    const drafts = chooseOption(emptyDrafts(QUESTIONS), 0, 0, SINGLE);
    expect(drafts.map(isAnswered)).toEqual([true, false, false]);
    expect(toAnswers(QUESTIONS, drafts)).toBeNull();
    // Whitespace is not an answer.
    expect(isAnswered(writeText(drafts, 2, "   ", TEXT)[2]!)).toBe(false);
  });
});
