// The `humanTurn` flag as the transcript READER sees it: both adapters answer "did a person write
// this" once, at the seam, so nothing downstream has to re-derive it from `type` alone.
//
// The rule itself is `humanTurns.ts` and is tested there. What is pinned here is that the adapters
// actually ask it, on the lines where the answer is not the obvious one -- because the failure this
// prevents is silent. A flag that is never set makes the affordance it gates disappear; a flag set
// on everything typed `user` puts it on tool results and harness envelopes, which is the same
// mistake a summarizer here already made once.

import { expect, test } from "bun:test";
import { SCRATCH_BRIEF_LABEL, withScratchBrief } from "@agentdesk/agent-feed-wire";
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";
import { codexAdapter } from "@/transcripts/codex/codexTranscript";

test("claude marks a person speaking", () => {
  const r = claudeAdapter.processLine(
    JSON.stringify({
      type: "user",
      timestamp: "2026-09-09T05:00:00.000Z",
      message: { role: "user", content: "do the thing" },
    }),
  );
  expect(r?.event?.humanTurn).toBe(true);
});

test("claude does not mark a tool result, which is recorded as the user", () => {
  const r = claudeAdapter.processLine(
    JSON.stringify({
      type: "user",
      timestamp: "2026-09-09T05:00:01.000Z",
      message: {
        role: "user",
        content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "ok" }],
      },
    }),
  );
  expect(r?.event?.humanTurn).toBeUndefined();
});

test("claude does not mark a harness envelope", () => {
  const r = claudeAdapter.processLine(
    JSON.stringify({
      type: "user",
      timestamp: "2026-09-09T05:00:02.000Z",
      message: { role: "user", content: "<system-reminder>read this first</system-reminder>" },
    }),
  );
  expect(r?.event?.humanTurn).toBeUndefined();
});

test("claude does not mark a line it flags as its own, whatever the text says", () => {
  // The note Claude adds when a tool reads an image. No envelope pattern knows it, and it reads as
  // prose; `isMeta` is what says a person did not write it.
  const r = claudeAdapter.processLine(
    JSON.stringify({
      type: "user",
      isMeta: true,
      timestamp: "2026-09-09T05:00:02.500Z",
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: "[Image: original 3200x1826, displayed at 2000x1141. Multiply coordinates by 1.60 to map to original image.]",
          },
        ],
      },
    }),
  );
  expect(r?.event?.humanTurn).toBeUndefined();
});

test("claude does not mark what the model said", () => {
  const r = claudeAdapter.processLine(
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-09T05:00:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    }),
  );
  expect(r?.event?.humanTurn).toBeUndefined();
});

test("codex marks a person speaking, and not its injected instructions", () => {
  const said = codexAdapter.processLine(
    JSON.stringify({
      timestamp: "2026-09-09T05:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "do the thing" }] },
    }),
  );
  expect(said?.event?.humanTurn).toBe(true);

  const injected = codexAdapter.processLine(
    JSON.stringify({
      timestamp: "2026-09-09T05:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions\n\nread these" }],
      },
    }),
  );
  expect(injected?.event?.humanTurn).toBeUndefined();
});

test("claude splits a scratch chat's brief out of the person's first message, and still marks it theirs", () => {
  const r = claudeAdapter.processLine(
    JSON.stringify({
      type: "user",
      timestamp: "2026-10-19T05:00:00.000Z",
      cwd: "/scratch/plan-1a2b",
      message: { role: "user", content: withScratchBrief("You are in a scratch folder.", "Plan the garden") },
    }),
  );
  expect(r?.event?.humanTurn).toBe(true);
  expect(r?.event?.blocks[0]).toEqual({
    kind: "metadata",
    label: SCRATCH_BRIEF_LABEL,
    text: "You are in a scratch folder.",
  });
  expect(r?.event?.blocks[1]).toEqual({ kind: "text", text: "Plan the garden" });
  expect(claudeAdapter.snippetFor(r!.event!)).toBe("→ Plan the garden");
});
