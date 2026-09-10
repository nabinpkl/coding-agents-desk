import { describe, expect, test } from "bun:test";
import { parseTranscriptWindow } from "@/tasks/taskIdentity";

/** One transcript record per line, the way the file itself is laid out. */
function window(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

function agentCall(id: string, input: Record<string, unknown>, at: string): unknown {
  return {
    type: "assistant",
    timestamp: at,
    message: { content: [{ type: "tool_use", id, name: "Agent", input }] },
  };
}

function agentResult(callId: string, result: Record<string, unknown>, at: string): unknown {
  return {
    type: "user",
    timestamp: at,
    toolUseResult: result,
    message: { content: [{ type: "tool_result", tool_use_id: callId }] },
  };
}

describe("parseTranscriptWindow, subagents", () => {
  test("pairs a launch with the call that made it", () => {
    const scan = parseTranscriptWindow(window(
      agentCall("toolu_1", {
        description: "Investigate transcript stream staleness",
        subagent_type: "fork",
        model: "opus",
        prompt: "...",
      }, "2026-09-09T21:51:11.714Z"),
      agentResult("toolu_1", {
        isAsync: true,
        status: "async_launched",
        agentId: "a6da370b26e85421c",
        description: "Investigate transcript stream staleness",
        resolvedModel: "claude-opus-5[1m]",
      }, "2026-09-09T21:51:12.000Z"),
    ));

    expect(scan.agents.get("a6da370b26e85421c")).toEqual({
      agentId: "a6da370b26e85421c",
      description: "Investigate transcript stream staleness",
      subagentType: "fork",
      model: "opus",
      resolvedModel: "claude-opus-5[1m]",
      // The CALL's timestamp, not the result's: the run started when it was asked for.
      startedAt: Date.parse("2026-09-09T21:51:11.714Z"),
      launchedAsync: true,
    });
  });

  test("a launch whose call fell outside the window still names itself", () => {
    const scan = parseTranscriptWindow(window(
      agentResult("toolu_gone", {
        status: "async_launched",
        agentId: "orphan-1",
        description: "the launch record carries its own words",
      }, "2026-09-09T21:51:12.000Z"),
    ));
    const agent = scan.agents.get("orphan-1");
    expect(agent?.description).toBe("the launch record carries its own words");
    // Unknowable without the call half, and said so rather than guessed.
    expect(agent?.subagentType).toBeNull();
    expect(agent?.model).toBeNull();
  });

  test("an agent with no description anywhere falls back to its id, never to a blank row", () => {
    const scan = parseTranscriptWindow(window(
      agentResult("toolu_x", { status: "async_launched", agentId: "bare-1" }, "2026-09-09T21:00:00.000Z"),
    ));
    expect(scan.agents.get("bare-1")?.description).toBe("bare-1");
  });

  test("an Agent call does not become a background shell, and vice versa", () => {
    const scan = parseTranscriptWindow(window(
      agentCall("toolu_1", { description: "a fork", subagent_type: "fork" }, "2026-09-09T21:00:00.000Z"),
      agentResult("toolu_1", { status: "async_launched", agentId: "agent-1" }, "2026-09-09T21:00:01.000Z"),
    ));
    expect(scan.agents.size).toBe(1);
    expect(scan.starts.size).toBe(0);
    expect(scan.monitors.size).toBe(0);
  });
});

describe("parseTranscriptWindow, the two notification shapes", () => {
  const notification = [
    "<task-notification>",
    "<task-id>a6da370b26e85421c</task-id>",
    "<status>completed</status>",
    "<summary>Agent finished</summary>",
    "<subagent_tokens>222837</subagent_tokens>",
    "</task-notification>",
  ].join("\n");

  test("reads one queued behind a turn, which arrives as an attachment", () => {
    const scan = parseTranscriptWindow(window({
      type: "attachment",
      timestamp: "2026-09-09T22:00:00.000Z",
      attachment: { type: "queued_command", prompt: notification },
    }));
    const found = scan.notifications.get("a6da370b26e85421c");
    expect(found?.kind).toBe("completion");
    expect(found).toMatchObject({ status: "completed", taskKind: "agent" });
  });

  // The shape that was being dropped. A notification delivered to an idle session is an ordinary
  // user message whose content is a plain string, and a subagent has no shell to contradict the
  // transcript with, so missing it left a finished run showing as running forever.
  test("reads one delivered to an idle session, which arrives as a plain user message", () => {
    const scan = parseTranscriptWindow(window({
      type: "user",
      timestamp: "2026-09-09T22:00:00.000Z",
      message: { role: "user", content: notification },
    }));
    const found = scan.notifications.get("a6da370b26e85421c");
    expect(found?.kind).toBe("completion");
    expect(found).toMatchObject({ status: "completed", taskKind: "agent" });
  });

  test("an ordinary user message is not mistaken for a notification", () => {
    const scan = parseTranscriptWindow(window({
      type: "user",
      timestamp: "2026-09-09T22:00:00.000Z",
      message: { role: "user", content: "do 3 and see if directory cluster landed" },
    }));
    expect(scan.notifications.size).toBe(0);
  });
});
