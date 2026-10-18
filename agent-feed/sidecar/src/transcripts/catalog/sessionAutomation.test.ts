import { expect, test } from "bun:test";
import { sessionAutomation } from "@/transcripts/catalog/sessionAutomation";
import type { Session } from "@/transcripts/transcriptTypes";

const session = (overrides: Partial<Session>): Session => ({
  sessionId: "11111111-1111-1111-1111-111111111111",
  source: "claude",
  project: "/repo",
  lastEventAt: 1,
  ...overrides,
});

test("the plugin's review and its adjudication pass are security reviews", () => {
  for (const firstPrompt of [
    "Review this change for security vulnerabilities. Changed files (you may Read these",
    "You previously flagged these candidate vulnerabilities: 1. ...",
  ]) {
    expect(sessionAutomation(session({ entrypoint: "sdk-py", firstPrompt }))).toBe("security-review");
  }
});

test("neither marker alone makes one", () => {
  // A person pasting the prompt into a terminal session.
  expect(
    sessionAutomation(
      session({
        entrypoint: "cli",
        firstPrompt: "Review this change for security vulnerabilities.",
      }),
    ),
  ).toBeUndefined();
  // A Python SDK tool of the owner's own.
  expect(sessionAutomation(session({ entrypoint: "sdk-py", firstPrompt: "Summarize the repo" }))).toBeUndefined();
  // A person's own request that only reads like one.
  expect(
    sessionAutomation(
      session({
        entrypoint: "sdk-py",
        firstPrompt: "Please Review this change for security vulnerabilities.",
      }),
    ),
  ).toBeUndefined();
  expect(
    sessionAutomation(
      session({
        source: "opencode",
        entrypoint: "sdk-py",
        firstPrompt: "Review this change for security vulnerabilities.",
      }),
    ),
  ).toBeUndefined();
});
