// Reads token usage out of Claude Code's own transcript files.
//
// The same shape of work as `codexUsage.ts` -- a cheap projection over every file there has ever
// been, not the rich per-line parse `SourceAdapter` does for a session somebody opened -- but it
// cannot produce the same ANSWER, and that difference is the whole reason this file exists
// separately rather than as a second branch inside the Codex one.
//
// A Codex rollout is a private ledger: each request appears in exactly one file, so summing files
// and adding the sums is correct. A Claude transcript is not. The same request appears many times,
// by two mechanisms, and both were measured on this machine over 1,388 files, 2.62 GB and 288,219
// usage records:
//
//   1. WITHIN one file, because one API response is written as several lines -- one per content
//      block, a `thinking` and two `tool_use` say -- and every one of them repeats the SAME
//      `message.usage`. 124,127 duplicate occurrences, 32.96 billion input tokens.
//   2. ACROSS files, because `claude --resume <id> --fork-session` copies the parent's history
//      verbatim into a new file. 58,674 duplicate occurrences, 18.65 billion input tokens.
//
// Summed naively that is 79.82 billion input tokens. Deduped by `message.id` it is 28.22 billion.
// A per-file sum would therefore have reported this machine's history at 283% of its real size --
// a number with no visible tell, since every day would simply look busier.
//
// So a scan yields per-request ROWS carrying their identity, and the report dedupes globally when
// it merges them. That is also why the cache cannot store pre-summed days for Claude the way it
// does for Codex: two files that share a request must be able to agree on who gets to count it,
// and a sum has thrown away what it would take to decide.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalClaudeModel } from "./claudeModels.ts";
import { readJsonLines } from "./readJsonLines.ts";
import { localDayKey } from "./usageTotals.ts";

/**
 * One API request: `[id, date, model, input, cached, output, reasoning]`.
 *
 * A tuple, and `requests` is not a member of it, for the same two reasons the totals are tuples:
 * this is the shape that goes in the cache, at roughly one row per request across a six-figure
 * history, and a row is one request by construction so a stored 1 would be a column of ones.
 *
 * `id` has its constant `msg_` prefix stripped -- it is on every id and pays only storage.
 */
export type ClaudeUsageRow = [string, string, string, number, number, number, number];

/** The model the harness stamps on lines it injected itself. No request was made, so none counts. */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * Present in every `usage` object the API has ever returned, and rare in prose.
 *
 * Less selective than the Codex markers -- 40% of lines here carry usage against 0.1% there -- but
 * selectivity is not what it is for. A marker that can miss a record loses spend silently, so this
 * is the field the shape guarantees rather than the one that filters best.
 */
const USAGE_MARKER = '"input_tokens"';

interface ClaudeLine {
  type?: string;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
      output_tokens_details?: { thinking_tokens?: number };
    };
  };
}

/**
 * Sums one transcript into one row per request, first occurrence winning.
 *
 * First rather than last because the copies are the same reading: across 105,452 distinct requests
 * only 58 differ in their token figures at all, only 2 in their model, and only 5 land on two
 * different local days -- the widest spread between any two copies of one request being six
 * minutes. So the choice is between equal answers, and the one that needs no second pass wins.
 *
 * `inputTokens` is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, because
 * Claude's `input_tokens` EXCLUDES both cache fields -- the opposite of Codex, where the cached
 * part is already inside the published figure. `cachedInputTokens` is `cache_read_input_tokens`
 * ALONE: cache creation is input that was processed fresh and written to the cache, so folding it
 * into "cached" would report the most expensive tokens in the record as the cheapest.
 */
export async function scanClaudeSession(path: string): Promise<ClaudeUsageRow[]> {
  const rows: ClaudeUsageRow[] = [];
  const seen = new Set<string>();

  await readJsonLines(path, (line) => {
    if (!line.includes(USAGE_MARKER)) return;

    let record: ClaudeLine;
    try {
      record = JSON.parse(line) as ClaudeLine;
    } catch {
      // A half-written tail on a session that is still running. The next scan sees the whole
      // record; nothing is lost but this one line, and only until then.
      return;
    }

    if (record.type !== "assistant") return;
    const usage = record.message?.usage;
    const id = record.message?.id;
    if (!usage || typeof id !== "string" || id.length === 0) return;
    if (record.message?.model === SYNTHETIC_MODEL) return;
    if (seen.has(id)) return;

    const atMs = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(atMs)) return;

    seen.add(id);
    const cached = number(usage.cache_read_input_tokens);
    rows.push([
      id.startsWith("msg_") ? id.slice(4) : id,
      localDayKey(atMs),
      canonicalClaudeModel(record.message?.model ?? "") || UNKNOWN_MODEL,
      number(usage.input_tokens) + cached + number(usage.cache_creation_input_tokens),
      cached,
      number(usage.output_tokens),
      number(usage.output_tokens_details?.thinking_tokens),
    ]);
  });

  return rows;
}

/** Records made before the transcript names a model. Attributed honestly rather than guessed. */
export const UNKNOWN_MODEL = "unknown";

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Every transcript Claude Code has kept.
 *
 * One flat `<projects>/<slug>/` directory per working tree, holding a `<session-uuid>.jsonl` per
 * session and an `agent-<hash>.jsonl` per subagent. Subagent files are counted: their tokens are a
 * separate API request that was separately paid for, and the dedup above is what keeps them from
 * being counted a second time wherever a parent's file also carries them.
 */
export async function findClaudeSessionFiles(projectsRoot: string): Promise<string[]> {
  const found: string[] = [];
  await collectJsonl(projectsRoot, found);
  return found.sort();
}

async function collectJsonl(directory: string, found: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // A vendor directory that does not exist is not an error here; whether the vendor is
    // installed at all is decided by the report, which checks for it explicitly.
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectJsonl(path, found);
    else if (entry.name.endsWith(".jsonl")) found.push(path);
  }
}

/**
 * Whether this machine has Claude records at all.
 *
 * Synchronous for the same reason `codexInstalled` is: `/api/config` answers synchronously and has
 * to say whether to offer the Usage surface, and one authority for the question is what keeps that
 * answer and the report's `installed` flag from disagreeing.
 */
export function claudeInstalled(projectsRoot: string): boolean {
  return existsSync(projectsRoot);
}
