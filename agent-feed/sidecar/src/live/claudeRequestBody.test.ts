// What a captured request body says, and the two ways of being wrong about it that cost real time:
// reading an identity that is not there, and reading one that is there but belongs to somebody else.

import { expect, test } from 'bun:test';
import {
  extractSessionId,
  extractToolResults,
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
