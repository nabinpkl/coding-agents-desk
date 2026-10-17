// Refuses a mod that can start turns from a place that runs once per turn.
//
// A mod that calls `$.prompt.submit` from `turn.complete` started a turn about once a second on
// Claude Code 2.1.301, with nothing in an interactive session to stop it but Escape (measured
// 2026-10-16). The prompt guard bounds that at runtime; this catches it before the mod loads. It
// reads what `claude plugin validate` prints, which is the same static analysis Claude Code runs
// when it loads a hooks module, so it judges the code that would actually run.
//
//   bun mods/checkModPrompts.ts            every mod under mods/
//   bun mods/checkModPrompts.ts <dir>...   the mods named

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Events that fire once per turn: a prompt submitted from one of these starts the next turn, forever. */
const PER_TURN_EVENT = /^(turn\.|classic\.(Stop|SubagentStop)\b)/;

export interface ModPromptVerdict {
  callsSubmit: boolean;
  /** The per-turn events the mod hooks while it can submit prompts; any at all is a failure. */
  perTurnHooks: string[];
  /** The mod also schedules timers, which this check cannot see into, so a person has to. */
  usesTimers: boolean;
}

/** Reads one `claude plugin validate` run. Several hooks modules in one mod are judged together. */
export function judgeValidateOutput(output: string): ModPromptVerdict {
  const hooks: string[] = [];
  const calls: string[] = [];
  for (const line of output.split("\n")) {
    const hooked = /❯ \S+ hooks: (.*)$/.exec(line);
    if (hooked) hooks.push(...hooked[1]!.split(",").map((h) => h.trim().replace(/\{.*\}$/, "")));
    const called = /❯ \S+ calls: (.*)$/.exec(line);
    if (called) calls.push(...called[1]!.split(",").map((c) => c.trim().replace(/ \(via .*\)$/, "")));
  }
  const callsSubmit = calls.includes("$.prompt.submit");
  return {
    callsSubmit,
    perTurnHooks: callsSubmit ? hooks.filter((h) => PER_TURN_EVENT.test(h)) : [],
    usesTimers: callsSubmit && calls.some((c) => c.startsWith("$.clock.")),
  };
}

function modsBesideThisFile(): string[] {
  const root = import.meta.dir;
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, ".claude-plugin", "plugin.json")))
    .map((entry) => join(root, entry.name));
}

if (import.meta.main) {
  const dirs = process.argv.length > 2 ? process.argv.slice(2) : modsBesideThisFile();
  let failed = false;
  for (const dir of dirs) {
    const run = Bun.spawnSync(["claude", "plugin", "validate", dir], { stdout: "pipe", stderr: "pipe" });
    const output = run.stdout.toString() + run.stderr.toString();
    if (run.exitCode !== 0) {
      console.error(`FAIL ${dir}: claude plugin validate exited ${run.exitCode}\n${output}`);
      failed = true;
      continue;
    }
    const verdict = judgeValidateOutput(output);
    if (verdict.perTurnHooks.length > 0) {
      console.error(`FAIL ${dir}: calls $.prompt.submit and hooks ${verdict.perTurnHooks.join(", ")}`);
      failed = true;
    } else if (verdict.usesTimers) {
      console.log(`WARN ${dir}: calls $.prompt.submit and schedules timers; check no timer submits`);
    } else {
      console.log(`ok   ${dir}${verdict.callsSubmit ? ": submits prompts, from no per-turn event" : ""}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
