import { describe, expect, test } from "bun:test";
// A mod imports its own files by relative path, and this test sits beside the module it covers.
import { LIMITS, admit, isUsersOwn, setPaused, settled, submittingMod, userTyped } from "./guard.js";

const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 16, 9, 0, 0);

/** Admits one prompt and lets it enter, the way the hooks module does on a prompt that went through. */
function sendAndEnter(state: unknown, sid: string, hash: string, now: number) {
  const decision = admit(state, sid, hash, now);
  return { ...decision, state: decision.ok ? settled(decision.state, sid) : decision.state };
}

describe("whose prompt it is", () => {
  test("a typed or pasted prompt is the person's, a mod's names the mod", () => {
    expect(isUsersOwn({ kind: "composer" })).toBe(true);
    expect(isUsersOwn(undefined)).toBe(true);
    expect(isUsersOwn({ kind: "plugin", name: "ad-loop" })).toBe(false);
    expect(submittingMod({ kind: "plugin", name: "ad-loop" })).toBe("ad-loop");
    // A peer's message or a task notice is neither, and the guard leaves it to Claude Code.
    expect(isUsersOwn({ kind: "peer" })).toBe(false);
    expect(submittingMod({ kind: "peer" })).toBeNull();
    expect(submittingMod({ kind: "composer" })).toBeNull();
  });
});

describe("since the person last typed", () => {
  test("mods get three turns, then wait for the person, and typing lets them go again", () => {
    let state: unknown = undefined;
    for (let i = 1; i <= LIMITS.sinceUser; i++) {
      const sent = sendAndEnter(state, "s1", `h${i}`, T0 + i * MIN);
      expect(sent.ok).toBe(true);
      state = sent.state;
    }
    const fourth = sendAndEnter(state, "s1", "h4", T0 + 4 * MIN);
    expect(fourth.ok).toBe(false);
    expect(fourth.reason).toStartWith("paused: mods sent 3 prompts since you last typed");

    state = userTyped(fourth.state, "s1", T0 + 5 * MIN);
    expect(sendAndEnter(state, "s1", "h5", T0 + 6 * MIN).ok).toBe(true);
  });

  test("the count is per session", () => {
    let state: unknown = undefined;
    for (let i = 1; i <= LIMITS.sinceUser; i++) state = sendAndEnter(state, "s1", `h${i}`, T0 + i).state;
    expect(sendAndEnter(state, "s1", "next", T0 + 10).ok).toBe(false);
    expect(sendAndEnter(state, "s2", "next", T0 + 10).ok).toBe(true);
  });

  test("a paused session stays paused while it is quiet, short of a week", () => {
    let state: unknown = undefined;
    for (let i = 1; i <= LIMITS.sinceUser; i++) state = sendAndEnter(state, "s1", `h${i}`, T0 + i).state;
    // Another session's activity six days later prunes nothing that is under a week old.
    state = sendAndEnter(state, "s2", "other", T0 + 6 * 24 * 60 * MIN).state;
    expect(sendAndEnter(state, "s1", "late", T0 + 6 * 24 * 60 * MIN + 1).ok).toBe(false);
  });
});

describe("one at a time", () => {
  test("a second prompt waits until the first has entered", () => {
    const first = admit(undefined, "s1", "a", T0);
    expect(first.ok).toBe(true);
    const second = admit(first.state, "s1", "b", T0 + 1000);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("a prompt a mod sent is still waiting to enter");
    expect(admit(settled(second.state, "s1"), "s1", "b", T0 + 2000).ok).toBe(true);
  });

  test("a prompt that never reported back stops blocking after ten minutes", () => {
    const first = admit(undefined, "s1", "a", T0);
    expect(admit(first.state, "s1", "b", T0 + LIMITS.pendingStaleMs - 1).ok).toBe(false);
    expect(admit(first.state, "s1", "b", T0 + LIMITS.pendingStaleMs).ok).toBe(true);
  });
});

describe("hourly caps", () => {
  test("a session gets six an hour even when the person keeps typing", () => {
    let state: unknown = undefined;
    for (let i = 1; i <= LIMITS.sessionPerHour; i++) {
      state = userTyped(state, "s1", T0 + i * MIN);
      const sent = sendAndEnter(state, "s1", `h${i}`, T0 + i * MIN + 1);
      expect(sent.ok).toBe(true);
      state = sent.state;
    }
    state = userTyped(state, "s1", T0 + 30 * MIN);
    const over = sendAndEnter(state, "s1", "over", T0 + 30 * MIN + 1);
    expect(over.ok).toBe(false);
    expect(over.reason).toBe("mods sent 6 prompts in this session in the last hour");
    // The first one ages out an hour after it was sent.
    expect(sendAndEnter(over.state, "s1", "over", T0 + MIN + LIMITS.hourMs + 2).ok).toBe(true);
  });

  test("the machine gets twenty an hour across every session", () => {
    let state: unknown = undefined;
    for (let i = 0; i < LIMITS.machinePerHour; i++) {
      const sent = sendAndEnter(state, `s${i}`, `h${i}`, T0 + i);
      expect(sent.ok).toBe(true);
      state = sent.state;
    }
    const over = sendAndEnter(state, "fresh", "h", T0 + 100);
    expect(over.ok).toBe(false);
    expect(over.reason).toBe("mods sent 20 prompts on this machine in the last hour");
  });
});

describe("duplicates, the switch, and what the store holds", () => {
  test("the same text is refused for ten minutes", () => {
    let state = sendAndEnter(userTyped(undefined, "s1", T0), "s1", "same", T0).state;
    state = userTyped(state, "s1", T0 + MIN);
    expect(sendAndEnter(state, "s1", "same", T0 + 2 * MIN).reason).toBe("a mod sent the same text less than 10 minutes ago");
    expect(sendAndEnter(state, "s1", "same", T0 + LIMITS.duplicateMs).ok).toBe(true);
  });

  test("/pause-mod-prompts stops every session until it is lifted", () => {
    const paused = setPaused(undefined, true);
    expect(admit(paused, "s1", "a", T0).reason).toStartWith("mod prompts are paused");
    expect(admit(setPaused(paused, false), "s1", "a", T0).ok).toBe(true);
  });

  test("a session quiet for a week is forgotten", () => {
    const state = sendAndEnter(undefined, "old", "a", T0).state;
    const later = admit(state, "new", "b", T0 + LIMITS.forgetSessionMs);
    expect(Object.keys(later.state.sessions)).toEqual(["new"]);
  });

  test("a stored value of the wrong shape starts from nothing rather than throwing", () => {
    for (const junk of [null, 7, "x", [], { machine: "no", sessions: [] }, { sessions: { s1: { hourly: "no", recent: [] } } }]) {
      expect(admit(junk, "s1", "a", T0).ok).toBe(true);
    }
  });
});
