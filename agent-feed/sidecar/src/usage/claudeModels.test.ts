import { expect, test } from "bun:test";
import { canonicalClaudeModel, claudeModelAlias } from "./claudeModels.ts";

test("a variant suffix and a release date are the same model, and are trimmed", () => {
  expect(canonicalClaudeModel("claude-opus-5[1m]")).toBe("claude-opus-5");
  expect(canonicalClaudeModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
});

test("models one character apart stay two models", () => {
  // The whole reason the trimming above is narrow. `fable-5` and `fable-5-1` are different
  // models, and a rule loose enough to merge them would be wrong without looking wrong.
  expect(canonicalClaudeModel("claude-fable-5")).not.toBe(canonicalClaudeModel("claude-fable-5-1"));
});

test("the alias carries the family and the version", () => {
  expect(claudeModelAlias("claude-opus-5")).toBe("opus 5");
  expect(claudeModelAlias("claude-opus-4-8")).toBe("opus 4.8");
  expect(claudeModelAlias("claude-fable-5-1")).toBe("fable 5.1");
  expect(claudeModelAlias("claude-haiku-4-5-20251001")).toBe("haiku 4.5");
});

test("an id that does not parse gets no alias rather than a guessed one", () => {
  // The full id is exact and still on the wire beside this, so a null costs a reader nothing
  // where a wrong short name would cost them the row's meaning.
  expect(claudeModelAlias("<synthetic>")).toBeNull();
  expect(claudeModelAlias("gpt-5.6-sol")).toBeNull();
  expect(claudeModelAlias("claude-unreleased-9")).toBeNull();
});
