// Waiting for a new pane to settle before attaching to it: one that has not started, one that never
// writes, one that never stops, and one that cannot be described. Split from the tmux sessions'
// main suite, which covers reading and starting sessions.

import { expect, test } from "bun:test";
import { waitForPaneToSettle } from "@/terminal/tmux/tmuxSessions";

test("waits until a pane stops changing, then attaches", async () => {
  // A pane that writes, writes again, then goes quiet: the wait ends after the quiet window rather
  // than at the first sample that happens to match.
  const samples = ["0 0 0", "3 1 0", "3 1 0", "9 4 2", "9 4 2", "9 4 2", "9 4 2"];
  let index = 0;
  let clock = 0;
  const result = await waitForPaneToSettle("pane", {
    quietMs: 200,
    pollMs: 100,
    timeoutMs: 5_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    sample: async () => samples[Math.min(index++, samples.length - 1)]!,
  });

  expect(result.settled).toBe(true);
  // The last change is seen at 300ms, and the 200ms quiet window clears at 500ms: the wait is
  // measured from the last CHANGE, not from the last poll that happened to repeat.
  expect(result.waitedMs).toBe(500);
});

test("does not mistake a pane that has not started yet for one that has finished", async () => {
  // The bug this exists to prevent, measured on a real fork: the CLI writes nothing for its first
  // second, so a wait that accepts quiet immediately returns before the startup it is waiting for
  // has begun, and the viewer receives the whole dump live anyway.
  const samples = [
    "0 0 0",
    "0 0 0",
    "0 0 0",
    "0 0 0",
    "0 0 0",
    "0 0 0", // 600ms of silence while it loads
    "40 3 1",
    "80 6 2", // then it writes
    "80 6 2",
    "80 6 2",
    "80 6 2",
    "80 6 2", // then it is done
  ];
  let index = 0;
  let clock = 0;
  const result = await waitForPaneToSettle("pane", {
    quietMs: 200,
    pollMs: 100,
    startupMs: 3_000,
    timeoutMs: 5_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    sample: async () => samples[Math.min(index++, samples.length - 1)]!,
  });

  expect(result.settled).toBe(true);
  // Past the silence, past the writing, and only then the quiet window -- not 200ms.
  expect(result.waitedMs).toBe(900);
});

test("stops waiting on a pane that never writes at all", async () => {
  let clock = 0;
  const result = await waitForPaneToSettle("pane", {
    quietMs: 200,
    pollMs: 100,
    startupMs: 500,
    timeoutMs: 10_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    sample: async () => "0 0 0",
  });

  // Nothing was ever written, so there is nothing for a capture to collapse and no reason to sit
  // out the full timeout.
  expect(result.settled).toBe(true);
  expect(result.waitedMs).toBe(500);
});

test("gives up on a pane that never stops writing rather than never attaching", async () => {
  let clock = 0;
  let index = 0;
  const result = await waitForPaneToSettle("pane", {
    quietMs: 200,
    pollMs: 100,
    timeoutMs: 1_000,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    sample: async () => `${index++} 0 0`,
  });

  // Watching a busy program late is right; refusing to watch it is not.
  expect(result.settled).toBe(false);
  expect(result.waitedMs).toBeGreaterThanOrEqual(1_000);
});

test("stops waiting when the pane cannot be described at all", async () => {
  let clock = 0;
  const result = await waitForPaneToSettle("pane", {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    sample: async () => {
      throw new Error("no such pane");
    },
  });

  // The attach that follows reports the real failure; waiting on it would only delay that.
  expect(result.settled).toBe(false);
  expect(result.waitedMs).toBe(0);
});
