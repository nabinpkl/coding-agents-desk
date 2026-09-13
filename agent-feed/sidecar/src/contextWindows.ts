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
  let best: { length: number; tokens: number } | null = null;
  for (const [prefix, tokens] of Object.entries(table)) {
    const candidate = prefix.toLowerCase();
    if (!id.startsWith(candidate)) continue;
    if (!best || candidate.length > best.length) {
      best = { length: candidate.length, tokens };
    }
  }
  return best?.tokens ?? null;
}
