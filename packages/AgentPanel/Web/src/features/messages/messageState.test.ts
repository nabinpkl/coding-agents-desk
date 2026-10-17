import { describe, expect, test } from "vitest";
import type { Message } from "@agentdesk/agent-feed-wire";
import { threadState } from "@/features/messages/messageState";

const message = (over: Partial<Message>): Message => ({
  id: "m1",
  threadId: "m1",
  inReplyTo: null,
  from: "claude:a",
  fromKind: "agent",
  to: "human",
  kind: "request",
  body: "x",
  refs: [],
  hops: 1,
  state: "delivered",
  toSession: null,
  deliveredTo: "human",
  deliveredAt: null,
  answeredBy: null,
  createdAt: "2026-10-17T00:00:00Z",
  expiresAt: "2026-10-24T00:00:00Z",
  ...over,
});

describe("threadState", () => {
  test("an agent's request or question to the owner needs a reply; a report does not", () => {
    expect(threadState([message({ kind: "request" })])).toBe("needs-you");
    expect(threadState([message({ kind: "question", state: "pushed" })])).toBe("needs-you");
    expect(threadState([message({ kind: "report" })])).toBe("done");
  });

  test("the owner's own question is not owed to the owner", () => {
    expect(threadState([message({ kind: "question", from: "human", fromKind: "human", to: "bot:a" })])).toBe("done");
  });
});
