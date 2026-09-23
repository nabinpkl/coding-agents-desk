// How many tokens a model's context holds, and how a model id finds its row.
//
// The table, the environment override that extends it, and the lookup are one idea: the lookup
// only makes sense against a table keyed the way this one is keyed, and a row added by the
// override has to match the same way a built-in row does.

// Context window per model, in tokens, for the Agent Panel's occupancy meter.
//
// Keyed by model-id PREFIX and matched longest-first, because the harness writes
// full ids (`claude-opus-4-8`) and CLI aliases (`sonnet`) interchangeably, and a
// point release must not silently drop the meter to a bare count. Only Claude
// reads this table: Codex publishes `model_context_window` in the transcript
// itself, which is authoritative and observed to change mid-project.
const DEFAULT_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "claude-opus": 200_000,
  "claude-sonnet": 200_000,
  "claude-haiku": 200_000,
  opus: 200_000,
  sonnet: 200_000,
  haiku: 200_000,
};

// The long-context tier is part of the model's ID, not a property of the model, and it is spelled
// as a suffix so no prefix key can express it. `claude-opus-5[1m]` and `claude-opus-5` are the
// same model with different windows, and the harness picks between them by the brackets alone:
// Claude Code 2.1.270 resolves the window with `/\[1m\]/i.test(id) ? 1_000_000 : 200_000` before
// consulting anything else, and its own unknown-model notice tells the reader to "append [1m] to
// the model name for 1M". Mirrored here rather than inferred, because the alternative is a table
// whose longest match for `claude-opus-5[1m]` is the `claude-opus` row -- the right answer for a
// different run of the same model, five times too small for this one.
const LONG_CONTEXT_SUFFIX = /\[1m\]/i;
const LONG_CONTEXT_TOKENS = 1_000_000;

// `AGENT_FEED_CONTEXT_WINDOWS="claude-opus-5=1000000,claude-sonnet=200000"`
// describes a model this build has never seen, or a long-context beta run,
// without a code change. Entries merge over the defaults rather than replacing
// them, so naming one model does not blank every other model's meter.
export function contextWindowEnvironment(name: string): Record<string, number> {
  const table: Record<string, number> = { ...DEFAULT_CONTEXT_WINDOWS };
  const raw = process.env[name];
  if (raw === undefined || raw === "") return table;
  for (const entry of raw.split(",")) {
    if (!entry.trim()) continue;
    const separator = entry.lastIndexOf("=");
    const prefix = separator > 0 ? entry.slice(0, separator).trim() : "";
    if (!prefix) {
      throw new Error(`${name} entries must be "modelPrefix=tokens"`);
    }
    const tokens = Number(entry.slice(separator + 1).trim());
    if (!Number.isSafeInteger(tokens) || tokens <= 0) {
      throw new Error(`${name} window for "${prefix}" must be a positive integer`);
    }
    table[prefix] = tokens;
  }
  return table;
}

/**
 * The same model id in its long-context tier.
 *
 * For a caller that learned the tier somewhere other than the id: the live mirror reads it off the
 * request's own `anthropic-beta` list, because a captured request names the model without it.
 * Returned as an ID rather than as a number so it goes back through the table above, which is what
 * keeps `AGENT_FEED_CONTEXT_WINDOWS="claude-opus-5[1m]=500000"` meaning what it says.
 */
export function longContextModelId(model: string): string {
  return LONG_CONTEXT_SUFFIX.test(model) ? model : `${model}[1m]`;
}

/**
 * The model's context window in tokens, or null when this build has no entry.
 *
 * Null is a real answer, not a failure: the panel then shows the occupancy count
 * with no fill bar, rather than a fraction of a number we guessed.
 */
export function contextWindowIn(
  table: Readonly<Record<string, number>>,
  model: string | undefined,
): number | null {
  if (!model) return null;
  const id = model.toLowerCase();
  let best: { prefix: string; tokens: number } | null = null;
  for (const [prefix, tokens] of Object.entries(table)) {
    const candidate = prefix.toLowerCase();
    if (!id.startsWith(candidate)) continue;
    if (!best || candidate.length > best.prefix.length) {
      best = { prefix: candidate, tokens };
    }
  }
  // A row that names the tier itself outranks the suffix rule, so the environment override stays
  // the escape hatch it is for -- `claude-opus-5[1m]=500000` still means 500,000. A row that does
  // not name it was written about the ordinary model and cannot answer for this one.
  if (best && LONG_CONTEXT_SUFFIX.test(best.prefix)) return best.tokens;
  if (LONG_CONTEXT_SUFFIX.test(id)) return LONG_CONTEXT_TOKENS;
  return best?.tokens ?? null;
}
