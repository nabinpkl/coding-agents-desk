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
 * per-session accumulation lives in the transcript reads: the meter read back from the end when a
 * thread opens, and the follow that folds each line it reads after that.
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
  // Sticky without the model's exception, because a cache lifetime is a property of the
  // client rather than of the model: switching model mid-session does not move it, and
  // the records that name no lifetime are the ones that wrote nothing to the cache --
  // a pure hit, and a compaction boundary, which carries no usage record at all and is
  // precisely when the reader most wants the clock still running.
  const cacheTtlMs = next.cacheTtlMs ?? previous?.cacheTtlMs;
  return {
    current: next.current,
    limit,
    updatedAt: next.updatedAt,
    ...(model ? { model } : {}),
    ...(cacheTtlMs ? { cacheTtlMs } : {}),
  };
}

/**
 * Fold one model declaration into the one the session is running under.
 *
 * Newest wins, with one exception: a declaration that names the same model MINUS its tier does not
 * replace a tiered one. The tier is the whole content of the window answer -- `claude-opus-5[1m]`
 * holds a million tokens and `claude-opus-5` holds two hundred thousand -- and the harness restates
 * the bare id often enough that taking the newest would quietly cut a session's window by five.
 *
 * Measured across the 58 transcripts here that carry declarations: four open with a tiered id and
 * then emit bare ones, on three different CLI versions, so this is a recurring shape rather than
 * one release's regression. One of the four goes tiered, bare, then tiered again with nobody
 * having touched the model, which is what rules out reading a bare declaration as a switch to the
 * smaller tier. The one that prompted this sat at 167,829 tokens reading 84% full of a window it
 * did not have, while its own status line said 16%.
 *
 * A genuinely different model still replaces it, tier or no tier. What cannot be distinguished
 * from here is a reader deliberately moving from the 1M tier to the 200k one mid-session, which
 * this keeps on the larger window. That is the cheaper error: the alternative is the meter
 * demanding a compaction at a sixth of the occupancy it claims.
 */
export function mergeDeclaredModel(
  previous: DeclaredModel | undefined,
  next: DeclaredModel,
): DeclaredModel {
  if (!previous) return next;
  return previous.model.startsWith(`${next.model}[`) ? previous : next;
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
