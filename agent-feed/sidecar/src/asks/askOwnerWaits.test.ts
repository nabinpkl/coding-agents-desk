import { expect, test } from "bun:test";
import type { AskOwnerCall, AskOwnerVerdict, WaitAskOwnerCommand } from "@agentdesk/agent-feed-wire";
import { AskOwnerWaits } from "@/asks/askOwnerWaits";

const SESSION = "2adc3708-fadb-4e2f-a744-322df224faf4";

function command(toolUseId: string, sessionId = SESSION): WaitAskOwnerCommand {
  return {
    toolUseId,
    source: "claude",
    sessionId,
    questions: [{ id: "name", question: "What should it be called?", kind: "text", options: [] }],
  };
}

function watched(waits: AskOwnerWaits, sessionId = SESSION) {
  const seen: string[][] = [];
  const stop = waits.observe("claude", sessionId, (asks: AskOwnerCall[]) =>
    seen.push(asks.map((ask) => ask.toolUseId)),
  );
  return { seen, stop };
}

test("shows a waiting call to its session's watchers, oldest first, and hands the answer to every waiter", () => {
  let clock = 10;
  const waits = new AskOwnerWaits(() => clock++);
  const { seen } = watched(waits);
  const verdicts: AskOwnerVerdict[] = [];
  waits.wait(command("toolu_b"), (verdict) => verdicts.push(verdict));
  waits.wait(command("toolu_a"), (verdict) => verdicts.push(verdict));
  // The same id again joins the call already waiting, as a reconnecting tool process does.
  waits.wait(command("toolu_b"), (verdict) => verdicts.push(verdict));
  expect(seen).toEqual([[], ["toolu_b"], ["toolu_b", "toolu_a"]]);

  const answers = [{ id: "name", chosen: [], text: "Ledger" }];
  expect(waits.answer("claude", SESSION, "toolu_b", answers)).toEqual({ delivered: true });
  expect(verdicts).toEqual([{ answered: answers }, { answered: answers }]);
  expect(seen.at(-1)).toEqual(["toolu_a"]);

  expect(waits.dismiss("claude", SESSION, "toolu_a")).toEqual({ delivered: true });
  expect(verdicts.at(-1)).toEqual({ dismissed: true });
  expect(seen.at(-1)).toEqual([]);
});

test("stops waiting when its last request goes, and refuses an answer after that", () => {
  const waits = new AskOwnerWaits();
  const { seen } = watched(waits);
  const first = waits.wait(command("toolu_a"), () => {});
  const second = waits.wait(command("toolu_a"), () => {});
  first();
  expect(seen.at(-1)).toEqual(["toolu_a"]);
  second();
  expect(seen.at(-1)).toEqual([]);
  expect(waits.answer("claude", SESSION, "toolu_a", [])).toMatchObject({ delivered: false, reason: "not-waiting" });
});

test("will not let one session answer another's call, nor take answers that do not fit", () => {
  const waits = new AskOwnerWaits();
  const verdicts: AskOwnerVerdict[] = [];
  waits.wait(command("toolu_a"), (verdict) => verdicts.push(verdict));
  const elsewhere = "9fe3988d-5392-4580-82f7-1659e881666c";
  expect(waits.dismiss("claude", elsewhere, "toolu_a")).toMatchObject({ reason: "not-waiting" });
  expect(waits.answer("claude", SESSION, "toolu_a", [{ id: "name", chosen: [] }])).toEqual({
    delivered: false,
    reason: "wrong-answers",
    message: '"What should it be called?" has no answer',
  });
  expect(verdicts).toEqual([]);
  // Still waiting after both refusals, and still answerable.
  expect(waits.answer("claude", SESSION, "toolu_a", [{ id: "name", text: "Ledger" }])).toEqual({ delivered: true });
});
