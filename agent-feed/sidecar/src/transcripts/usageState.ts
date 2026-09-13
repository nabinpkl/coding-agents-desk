import type { DeclaredModel, TokenUsage } from "@/transcripts/transcriptTypes";

/**
 * Fold one line's occupancy report into the session's running total.
 *
 * `current` always takes the newest value -- it is occupancy, not history, and
 * every report supersedes the last. `limit` and `model` are sticky: a report that
 * names neither inherits both, because plenty of records publish occupancy
 * without naming the model that produced it (Codex `token_count`, Claude lines
 * stamped `<synthetic>`), and letting those blank the meter would make it flicker
 * on exactly the records that arrive most often.
 *
 * Pure and stateless so the sticky rule is testable without a transcript; the
 * per-session accumulation lives in the event index, which is the one pass that
 * already sees every line.
 */
export function mergeUsage(
  previous: TokenUsage | undefined,
  next: TokenUsage,
): TokenUsage {
  const model = next.model ?? previous?.model;
  // A named model owns its own limit, INCLUDING when that limit is null: a
  // switch to a model this build has no window for has to show a bare count,
  // not the previous model's window applied to a different context size.
  const limit =
    next.model === undefined
      ? next.limit ?? previous?.limit ?? null
      : next.limit;
  return {
    current: next.current,
    limit,
    updatedAt: next.updatedAt,
    ...(model ? { model } : {}),
  };
}

/**
 * Restate an occupancy report in terms of the model the session DECLARED it was running.
 *
 * Only where the two are the same model. Claude's usage records name the API's id
 * (`claude-opus-5`) and the harness's declaration names the run (`claude-opus-5[1m]`), so the
 * report is about the declared model exactly when the declaration is that id with a tier appended.
 * Anything else is a different model -- 13 of 129 sessions in this project switch mid-way -- and a
 * 1M window applied to a 200k run would read as a quarter full when it was nearly out.
 *
 * A report that names no model at all is left alone: `mergeUsage` inherits the last named model
 * and its limit, which by then is the declared one, and claiming the declaration for a line that
 * did not name a model would be asserting something the line does not say.
 */
export function withDeclaredModel(
  usage: TokenUsage,
  declared: DeclaredModel | undefined,
): TokenUsage {
  if (!declared || usage.model === undefined) return usage;
  if (declared.model === usage.model) return usage;
  if (!declared.model.startsWith(`${usage.model}[`)) return usage;
  return { ...usage, model: declared.model, limit: declared.limit };
}
