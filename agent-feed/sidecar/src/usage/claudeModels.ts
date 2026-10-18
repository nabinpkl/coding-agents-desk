// Two spellings of one Claude model, and the short name a reader recognises.
//
// Both facts ride the wire (`UsageModelTotals.model` and `.alias`) rather than one being collapsed
// into the other: the id is what the record states and what a later question about pricing needs,
// the alias is what stops five rows of `claude-…-…-…` reading as one blur.
//
// Measured over 288,219 usage records on this machine: `message.model` is always a full id, never
// a CLI alias, and the ids present are `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`,
// `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-fable-5`, `claude-fable-5-1`,
// `claude-haiku-4-5-20251001`, and `<synthetic>`.

/**
 * The id with the two suffixes that do not name a different model removed.
 *
 * Deliberately narrow. A `[1m]` suffix selects a context window and a trailing `-YYYYMMDD` is a
 * release date; neither is a different model, and leaving them in splits one model across two rows.
 * Nothing else is folded: `claude-fable-5` and `claude-fable-5-1` differ by one character and are
 * genuinely different models, so any rule that trimmed further would merge them and be wrong
 * without looking wrong.
 */
export function canonicalClaudeModel(model: string): string {
  return model
    .trim()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
}

const FAMILIES = ["opus", "sonnet", "haiku", "fable"] as const;

/**
 * `claude-opus-4-8` -> `opus 4.8`, `claude-haiku-4-5-20251001` -> `haiku 4.5`.
 *
 * The family word alone is what the CLI takes as an alias, and it is what the owner asked for --
 * but three of the ids on this machine are `opus`, so the bare word would render three rows with
 * identical labels in a list whose whole job is to say which model a day went on. The version is
 * appended for that reason, and the full id stays on the wire beside it.
 *
 * Null for anything that does not parse, including `<synthetic>` and any future id shaped
 * differently: a guessed short name is worse than none, because the id under it is still exact.
 */
export function claudeModelAlias(model: string): string | null {
  const match = /^claude-([a-z]+)((?:-\d+)*)$/.exec(canonicalClaudeModel(model));
  if (!match) return null;
  const family = match[1]!;
  if (!(FAMILIES as readonly string[]).includes(family)) return null;
  const version = match[2]!.slice(1).split("-").filter(Boolean).join(".");
  return version ? `${family} ${version}` : family;
}
