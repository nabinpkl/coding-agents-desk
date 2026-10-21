import { describe, expect, test } from "bun:test";
import { emptySpokenStatusTrack, followSpokenStatus } from "@/transcripts/claude/claudeSpokenStatus";

const AT = "2026-10-21T01:00:00.000Z";

function assistant(content: unknown[], fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "assistant", timestamp: AT, message: { role: "assistant", content }, ...fields });
}

function user(content: unknown): string {
  return JSON.stringify({ type: "user", timestamp: AT, message: { role: "user", content } });
}

const status = (line: string) => [{ type: "text", text: `All set.\n\n<spoken-status>\n${line}\n</spoken-status>` }];
const ask = {
  type: "tool_use",
  id: "toolu_ask",
  name: "AskUserQuestion",
  input: { questions: [{ question: "Rebuild now?" }] },
};

function follow(...lines: string[]) {
  const track = emptySpokenStatusTrack();
  for (const line of lines) followSpokenStatus(line, track);
  return track.status;
}

describe("a Claude session's spoken status", () => {
  test("is the block its latest response closed with", () => {
    expect(follow(user("go"), assistant(status("done: shipped")))?.lines).toEqual([{ kind: "done", text: "shipped" }]);
  });

  test("is cleared when the person starts a new turn, and not by a tool result", () => {
    expect(follow(assistant(status("done: shipped")), user("next thing"))).toBeNull();
    const toolResult = user([{ type: "tool_result", tool_use_id: "toolu_x", content: "ok" }]);
    expect(follow(assistant(status("done: shipped")), toolResult)?.lines[0]?.text).toBe("shipped");
  });

  test("is the question it waits on, until that question is answered", () => {
    const waiting = follow(user("go"), assistant([ask]));
    expect(waiting).toMatchObject({ from: "question", lines: [{ kind: "waiting", text: "Rebuild now?" }] });
    const answer = user([{ type: "tool_result", tool_use_id: "toolu_ask", content: "yes" }]);
    expect(follow(user("go"), assistant([ask]), answer)).toBeNull();
  });

  test("ignores a subagent's turn", () => {
    expect(follow(assistant(status("done: theirs"), { isSidechain: true }))).toBeNull();
  });
});
