// What a captured request body says, and the two ways of being wrong about it that cost real time:
// reading an identity that is not there, and reading one that is there but belongs to somebody else.

import { expect, test } from 'bun:test';
import {
  extractSessionId,
  extractToolResults,
  isCompactionRequest,
  isConversationTurn,
  isSubagentRequest,
} from "@/live/claudeRequestBody";

test("extractSessionId reads a top-level user_id JSON string", () => {
  const body = JSON.stringify({
    user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-top" }),
  });
  expect(extractSessionId(body)).toBe("sess-top");
});

test("extractSessionId reads the user string parameter", () => {
  const body = JSON.stringify({
    user: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-user" }),
  });
  expect(extractSessionId(body)).toBe("sess-user");
});

test("extractSessionId reads user.metadata.user_id", () => {
  const body = JSON.stringify({
    user: { metadata: { user_id: JSON.stringify({ session_id: "sess-meta" }) } },
  });
  expect(extractSessionId(body)).toBe("sess-meta");
});

test("extractSessionId finds a nested user_id by raw unescape", () => {
  const identity = JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-nested" });
  const body = JSON.stringify({
    model: "claude",
    messages: [{ role: "user", content: "hi" }],
    system: [{ type: "tool", payload: { user_id: identity } }],
  });
  expect(extractSessionId(body)).toBe("sess-nested");
});

test("extractSessionId returns null for bodies without identity", () => {
  expect(extractSessionId(JSON.stringify({ model: "claude" }))).toBeNull();
  expect(extractSessionId("not json")).toBeNull();
  expect(extractSessionId(JSON.stringify({ user_id: "not-json" }))).toBeNull();
});

test("extractToolResults reads tool_result blocks from the final user message", () => {
  const body = JSON.stringify({
    model: "claude",
    messages: [
      { role: "user", content: "head " },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42 lines of output" }] },
    ],
  });
  const results = extractToolResults(body);
  expect(results).toHaveLength(1);
  expect(results[0]!.toolUseId).toBe("toolu_1");
  expect(results[0]!.text).toBe("42 lines of output");
});

test("extractToolResults handles structured content and ignores non-tool turns", () => {
  const structured = JSON.stringify({
    model: "claude",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }] },
    ],
  });
  expect(extractToolResults(structured)[0]!.text).toBe("ok");
  const prompt = JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hello" }] });
  expect(extractToolResults(prompt)).toHaveLength(0);
});

test("isSubagentRequest reads the harness billing token out of the system prompt", () => {
  // The header exactly as measured on the wire, including the `; ` separators around it.
  const body = JSON.stringify({
    system: [{
      type: "text",
      text: "x-anthropic-billing-header: cc_version=2.1.268.58f; cc_entrypoint=cli; cch=eeb8b;"
        + " cc_is_subagent=true; cc_prompt_id=2a5f44c0-0db0-4745-a365-df4dadab823b;",
    }],
    user_id: JSON.stringify({ session_id: "sess-parent" }),
  });
  expect(isSubagentRequest(body)).toBe(true);
  // And the session id it carries is the PARENT's, which is the whole reason the flag is needed:
  // nothing else in the request says these are two different conversations.
  expect(extractSessionId(body)).toBe("sess-parent");
});

test("isSubagentRequest ignores the token when it is only in the conversation", () => {
  // Measured, not imagined: 2 of 24 captured flows matched a whole-body search wrongly, and both
  // were an ordinary turn whose tool_result happened to quote the token -- because the session was
  // reading about it. Any session that opens this file does the same on its next request, and the
  // cost of believing it is a live mirror that goes silent for exactly the reader investigating.
  const body = JSON.stringify({
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.268.2c0; cch=af4dd;" }],
    messages: [{
      role: "user",
      content: [{ type: "tool_result", content: "the detector matches cc_is_subagent=true in the body" }],
    }],
    user_id: JSON.stringify({ session_id: "sess-parent" }),
  });
  expect(isSubagentRequest(body)).toBe(false);
});

test("isSubagentRequest takes a system prompt sent as one string", () => {
  expect(isSubagentRequest(JSON.stringify({ system: "hdr: cc_is_subagent=true; x=1" }))).toBe(true);
});

test("isSubagentRequest is false for an ordinary turn", () => {
  // The parent's header does not carry the pair at all -- measured; it is not sent as false -- so
  // presence is the signal and absence is every other request in the world.
  const ordinary = JSON.stringify({
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.268.2c0; cch=af4dd;" }],
  });
  expect(isSubagentRequest(ordinary)).toBe(false);
  expect(isSubagentRequest(JSON.stringify({ model: "claude" }))).toBe(false);
  expect(isSubagentRequest("not json")).toBe(false);
  expect(isSubagentRequest("")).toBe(false);
});

/** The harness's billing line, as measured on the wire, with whatever tail the case needs. */
function billed(tail: string): string {
  return JSON.stringify({
    system: [
      { type: "text", text: `x-anthropic-billing-header: cc_version=2.1.270.119; cc_entrypoint=cli; cch=53b3d;${tail}` },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
    ],
    user_id: JSON.stringify({ session_id: "sess-one" }),
  });
}

test("isConversationTurn reads the prompt id the harness stamps on a real turn", () => {
  expect(isConversationTurn(billed(" cc_prompt_id=711e45f5-7a05-4be5-a922-cd31437e1707;"))).toBe(true);
});

test("isConversationTurn rejects the harness's own errands, which name no prompt", () => {
  // Measured 2026-09-14 on a throwaway session compacted twice: the compaction summariser and the
  // composer's suggestion call both carry the session's own id and neither is a subagent, so
  // nothing else stops them streaming into the thread. The summariser is the one that shows,
  // because it lands on the compaction banner and buries it under half a summary nobody wrote.
  expect(isConversationTurn(billed(" cc_prev_req=req_011Cf2s9jyovKWXfRAHetSU6;"))).toBe(false);
  // `cc_prev_req` rides on ordinary turns too, so it is the prompt id that decides and not this.
  expect(isConversationTurn(
    billed(" cc_prev_req=req_011Cf2s9jyovKWXfRAHetSU6; cc_prompt_id=711e45f5-7a05-4be5-a922-cd31437e1707;"),
  )).toBe(true);
});

test("isConversationTurn reads a body with no billing header at all as a turn", () => {
  // The only absence-driven rule in this file, so it fails towards the behaviour of the day before
  // it landed. A harness that stops sending the header loses the summariser filter; one that is
  // trusted to have sent it loses every session's live mirror at once.
  expect(isConversationTurn(JSON.stringify({ model: "claude", messages: [] }))).toBe(true);
  expect(isConversationTurn("not json")).toBe(true);
});

test("isConversationTurn ignores a prompt id that is only in the conversation", () => {
  // Same trap as the subagent token: a session reading this file quotes `cc_prompt_id=` in its own
  // next request, and a whole-body search would then call every summariser it runs a turn.
  const body = JSON.stringify({
    system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.270.119; cc_prev_req=req_01;" }],
    messages: [{
      role: "user",
      content: [{ type: "tool_result", content: "the rule matches cc_prompt_id=abc in the body" }],
    }],
  });
  expect(isConversationTurn(body)).toBe(false);
});

/** The summariser's request: an errand, with the harness's own instruction as the last message. */
function summariser(instruction: string, tail = " cc_prev_req=req_011Cf2s9jyovKWXfRAHetSU6;"): string {
  return JSON.stringify({
    system: [{ type: "text", text: `x-anthropic-billing-header: cc_version=2.1.270.d34;${tail}` }],
    messages: [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: instruction },
    ],
    user_id: JSON.stringify({ session_id: "sess-one" }),
  });
}

const SUMMARISE = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n"
  + "Your task is to create a detailed summary of the conversation so far, paying close attention"
  + " to the user's explicit requests and your previous actions.";

test("isCompactionRequest picks the summariser out of the harness's other errands", () => {
  expect(isCompactionRequest(summariser(SUMMARISE))).toBe(true);
  // The composer's suggestion call is the other errand measured on the wire, and it is not this.
  expect(isCompactionRequest(summariser(
    "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]",
  ))).toBe(false);
});

test("isCompactionRequest finds the instruction behind the context-window message a 1M model gets", () => {
  // The harness appends this after the instruction on a 1M-context session, which is the size of
  // context whose compaction runs long enough for the notice to matter.
  const body = JSON.parse(summariser(SUMMARISE)) as { messages: unknown[] };
  body.messages.push({ role: "system", content: "<total_tokens>14897832 tokens left</total_tokens>" });
  expect(isCompactionRequest(JSON.stringify(body))).toBe(true);
});

test("isCompactionRequest never fires on a turn, however the conversation quotes it", () => {
  // The order is the safety. This is the only content-matched rule here, and the sentence it
  // matches lives in `messages`, which is the one part of the body a conversation can write into:
  // a session reading this file puts it in its own next request. That request carries a prompt id,
  // so it is a turn before the sentence is ever looked at.
  const turn = summariser(SUMMARISE, " cc_prompt_id=711e45f5-7a05-4be5-a922-cd31437e1707;");
  expect(isConversationTurn(turn)).toBe(true);
  expect(isCompactionRequest(turn)).toBe(false);
  expect(isCompactionRequest("not json")).toBe(false);
});
