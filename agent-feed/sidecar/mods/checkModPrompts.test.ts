import { describe, expect, test } from "bun:test";
import { judgeValidateOutput } from "./checkModPrompts";

// Captured from `claude plugin validate` on Claude Code 2.1.301 (2026-10-16).
const LOOPING_MOD = `Validating hooks: /tmp/ad-loop/hooks/hooks.json
  ❯ ./register.js hooks: turn.complete, prompt.submit
  ❯ ./register.js calls: $.env.get (via loopOnce), $.fs.read (via record), $.prompt.submit (via loopOnce), $.session.id, $.store.get, $.store.set
✔ Validation passed with warnings`;

const RECEIVING_MOD = `Validating hooks: /tmp/ad-verify/hooks/hooks.json
  ❯ ./register.js hooks: session.start, command.run{command=ad-pause}, command.run{command=ad-resume}, prompt.submit, session.receive
  ❯ ./register.js calls: $.command.register, $.process.run (via check), $.prompt.submit (via sendForUser), $.session.id, $.store.get
✔ Validation passed with warnings`;

const GUARD = `Validating hooks: /repo/mods/prompt-guard/hooks/hooks.json
  ❯ ./register.js hooks: session.start, command.run{command=pause-mod-prompts}, command.run{command=resume-mod-prompts}, prompt.submit
  ❯ ./register.js gating hook with .catch: prompt.submit
  ❯ ./register.js calls: $.command.register, $.session.id, $.store.get, $.store.set, $.ui.log, $.ui.status
✔ Validation passed`;

describe("judgeValidateOutput", () => {
  test("a mod that submits from turn.complete fails", () => {
    expect(judgeValidateOutput(LOOPING_MOD)).toEqual({ callsSubmit: true, perTurnHooks: ["turn.complete"], usesTimers: false });
  });

  test("a mod that submits only when a message arrives passes", () => {
    expect(judgeValidateOutput(RECEIVING_MOD)).toEqual({ callsSubmit: true, perTurnHooks: [], usesTimers: false });
  });

  test("a mod that hooks prompts without submitting any is not judged", () => {
    expect(judgeValidateOutput(GUARD)).toEqual({ callsSubmit: false, perTurnHooks: [], usesTimers: false });
  });

  test("a settings-hook Stop event counts as per turn, and timers are flagged for a person", () => {
    const output = `  ❯ ./a.js hooks: classic.Stop, session.receive
  ❯ ./a.js calls: $.clock.every, $.prompt.submit
  ❯ ./b.js hooks: turn.start{model=haiku}
  ❯ ./b.js calls: $.ui.log`;
    expect(judgeValidateOutput(output)).toEqual({ callsSubmit: true, perTurnHooks: ["classic.Stop", "turn.start"], usesTimers: true });
  });
});
