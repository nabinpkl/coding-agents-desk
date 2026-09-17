// What is worth pinning here is the ORDER, not the name.
//
// The name a pane ends up with is `tmuxSessionNames.ts`'s answer and is tested there. What this
// module decides is whether the pane is allowed to give up the name it has -- and the failure that
// matters is a rename that goes through when the stamp did not, because that produces a pane
// findable by neither its identity nor its name.

import { expect, test } from "bun:test";
import { adoptTitleName, type TmuxRelabelDeps } from "@/terminal/tmux/tmuxRelabel";

/** A tmux that remembers the calls, with each answer overridable per test. */
function fake(overrides: Partial<TmuxRelabelDeps> & { sessions?: string[] } = {}) {
  const calls: string[] = [];
  const sessions = overrides.sessions ?? [];
  const deps: TmuxRelabelDeps = {
    stamp: async (session, sessionId) => { calls.push(`stamp ${session} ${sessionId}`); },
    stamped: async (sessionId) => { calls.push(`stamped ${sessionId}`); return "agentdesk-s1"; },
    list: async () => { calls.push("list"); return sessions.map((name) => ({ name })); },
    rename: async (session, name) => { calls.push(`rename ${session} ${name}`); },
    ...overrides,
  };
  return { deps, calls };
}

test("a pane whose stamp reads back takes the session's title", async () => {
  const { deps, calls } = fake();
  expect(await adoptTitleName("agentdesk-s1", "s1", "Testing bot", deps)).toBe("testing-bot");
  expect(calls).toEqual([
    "stamp agentdesk-s1 s1",
    "stamped s1",
    "list",
    "rename agentdesk-s1 testing-bot",
  ]);
});

test("a stamp that does not read back leaves the name alone", async () => {
  // The case this module exists for. `set-option` can fail with the option silently unset, and a
  // pane renamed on the strength of a write that did not land is findable by nothing at all.
  const { deps, calls } = fake({ stamped: async () => null });
  expect(await adoptTitleName("agentdesk-s1", "s1", "Testing bot", deps)).toBe("agentdesk-s1");
  expect(calls.some((call) => call.startsWith("rename"))).toBe(false);
});

test("a stamp naming a different pane leaves the name alone", async () => {
  // Two panes claiming one session is a bug elsewhere, and renaming on that reading would move the
  // name of whichever pane this call happened to be holding.
  const { deps, calls } = fake({ stamped: async () => "somebody-elses-pane" });
  expect(await adoptTitleName("agentdesk-s1", "s1", "Testing bot", deps)).toBe("agentdesk-s1");
  expect(calls.some((call) => call.startsWith("rename"))).toBe(false);
});

test("a name already taken by another session gets the id suffix rather than the name", async () => {
  const { deps } = fake({ sessions: ["testing-bot"] });
  expect(await adoptTitleName("agentdesk-s1", "s1abcdef-0000", "Testing bot", deps))
    .toBe("testing-bot-s1abcd");
});

test("its own name does not count as taken, so a second call is not a second suffix", async () => {
  // A pane being relabelled in place is in the listing under its current name. Counting that would
  // suffix every rename after the first, and the session list would grow ids back.
  const { deps } = fake({ sessions: ["testing-bot", "other"] });
  expect(await adoptTitleName("testing-bot", "s1", "Testing bot", deps)).toBe("testing-bot");
});

test("a stamp that throws stops before anything is renamed", async () => {
  const { deps, calls } = fake({
    // Records BEFORE throwing, so the assertion below is about what did not follow it rather than
    // about a spy that never ran.
    stamp: async (session) => { calls.push(`stamp ${session}`); throw new Error("no tmux"); },
  });
  expect(await adoptTitleName("agentdesk-s1", "s1", "Testing bot", deps)).toBe("agentdesk-s1");
  expect(calls).toEqual(["stamp agentdesk-s1"]);
});

test("a rename tmux refuses is reported as the name the pane still has", async () => {
  // The pane is running either way, and the caller puts this name on the wire. Answering with the
  // name that was attempted would tell every later lookup to address a session tmux does not have.
  const { deps } = fake({ rename: async () => { throw new Error("bad name"); } });
  expect(await adoptTitleName("agentdesk-s1", "s1", "Testing bot", deps)).toBe("agentdesk-s1");
});

test("a listing that fails leaves the pane named after its session", async () => {
  const { deps } = fake({ list: async () => { throw new Error("tmux gone"); } });
  expect(await adoptTitleName("agentdesk-s1", "s1", "Testing bot", deps)).toBe("agentdesk-s1");
});
