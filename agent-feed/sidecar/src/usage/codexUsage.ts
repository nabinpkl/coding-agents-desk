// Reads token usage out of Codex's own rollout files.
//
// Deliberately NOT an extension of `SourceAdapter`, which is the existing per-vendor seam for
// transcripts. That seam's `processLine` builds a full `ActivityEvent` per line -- blocks, capped
// previews, line class -- which is right for rendering one session and ruinous across the 5 GB
// this has to sweep. The two reads are different in kind: that one is a rich parse of a file
// somebody opened, this is a cheap projection over every file there has ever been.
//
// Verified against a real history of 949 sessions: 176,071 usage records over 106 days.

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonLines } from "./readJsonLines.ts";
import type { QuotaSample } from "./quotaSample.ts";
import {
  addInto,
  emptyTuple,
  localDayKey,
  type DayModelTotals,
  type UsageTuple,
} from "./usageTotals.ts";

export interface ScannedSession {
  days: DayModelTotals;
  quota: QuotaSample | null;
}

/** Records made before the file names a model. Attributed honestly rather than guessed. */
export const UNKNOWN_MODEL = "unknown";

/**
 * Every line that matters contains one of these, and 99.9% of lines contain neither.
 *
 * The substring test is what makes the sweep affordable: `JSON.parse` runs on roughly one line in
 * a thousand. `rate_limits` rides the same records as `token_count`, so it needs no test of its
 * own.
 */
const TOKEN_COUNT_MARKER = '"token_count"';
const TURN_CONTEXT_MARKER = '"turn_context"';

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    model?: string;
    info?: {
      last_token_usage?: {
        input_tokens?: number;
        cached_input_tokens?: number;
        output_tokens?: number;
        reasoning_output_tokens?: number;
      };
    };
    rate_limits?: {
      plan_type?: string | null;
      primary?: {
        used_percent?: number;
        window_minutes?: number;
        resets_at?: number;
      } | null;
    };
  };
}

/**
 * Sums one rollout file into per-day, per-model totals.
 *
 * `last_token_usage` is the per-request figure and is what gets summed; `total_token_usage` in
 * the same record is the session's running total. Verified additive on real records (39,520 then
 * a further 39,747 reaching a cumulative 79,267), and summing the deltas is what lets each
 * request land on the calendar day it actually happened -- a session running past midnight
 * contributes to two dates, where reading the session's final cumulative figure would put all of
 * it on one.
 */
export async function scanCodexSession(path: string): Promise<ScannedSession> {
  const days: DayModelTotals = {};
  let model = UNKNOWN_MODEL;
  let quota: QuotaSample | null = null;

  await readJsonLines(path, (line) => {
    const isUsage = line.includes(TOKEN_COUNT_MARKER);
    if (!isUsage && !line.includes(TURN_CONTEXT_MARKER)) return;

    let record: CodexLine;
    try {
      record = JSON.parse(line) as CodexLine;
    } catch {
      // A half-written tail on a session that is still running. The next scan sees the whole
      // record; nothing is lost but this one line, and only until then.
      return;
    }

    if (record.type === "turn_context") {
      const named = record.payload?.model;
      if (typeof named === "string" && named.length > 0) model = named;
      return;
    }
    if (!isUsage || record.payload?.type !== "token_count") return;

    const atMs = Date.parse(record.timestamp ?? "");
    if (!Number.isFinite(atMs)) return;

    const usage = record.payload.info?.last_token_usage;
    if (usage) {
      // `input_tokens` ALREADY INCLUDES `cached_input_tokens` in Codex's records. It is stored
      // exactly as published, with the cached part alongside it as a subset; see the note on
      // `UsageTotals` for why adding the two is the failure mode worth naming.
      const tuple: UsageTuple = [
        number(usage.input_tokens),
        number(usage.cached_input_tokens),
        number(usage.output_tokens),
        number(usage.reasoning_output_tokens),
        1,
      ];
      const date = localDayKey(atMs);
      const byModel = (days[date] ??= {});
      addInto((byModel[model] ??= emptyTuple()), tuple);
    }

    const primary = record.payload.rate_limits?.primary;
    if (primary && typeof primary.used_percent === "number" && (!quota || atMs > quota.atMs)) {
      quota = {
        atMs,
        usedPercent: primary.used_percent,
        windowMinutes: number(primary.window_minutes),
        resetsAtMs: number(primary.resets_at) * 1000,
        planType: record.payload.rate_limits?.plan_type ?? null,
      };
    }
  });

  return { days, quota };
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Every rollout file Codex has kept, including archived ones.
 *
 * Live sessions are filed under `sessions/YYYY/MM/DD/`; archiving a thread moves its file to a
 * flat `archived_sessions/`. Both are usage that happened, so both are counted -- and the file
 * carries its own per-record timestamps, so a file that moved directories still lands on the
 * right days.
 */
export async function findCodexSessionFiles(codexHome: string): Promise<string[]> {
  const roots = [join(codexHome, "sessions"), join(codexHome, "archived_sessions")];
  const found: string[] = [];
  for (const root of roots) await collectJsonl(root, found);
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
 * Whether this machine has Codex records at all.
 *
 * Synchronous because `/api/config` answers synchronously and has to say whether to offer the
 * Usage surface at all. One authority for the question, so the config's answer and the report's
 * `installed` flag cannot disagree.
 */
export function codexInstalled(codexHome: string): boolean {
  return existsSync(join(codexHome, "sessions"));
}
