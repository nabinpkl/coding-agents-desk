import { describe, expect, test } from "bun:test";
import type { ClaudePermissionMode } from "@agentdesk/agent-feed-wire";
import { setTmuxPermissionMode } from "@/input/permissionModeSwitch";
import { runtime, screenWith } from "@/input/tmuxComposerHarness";
import { TmuxUnavailable } from "@/terminal/tmux/tmuxSessions";

const FOOTERS: Record<ClaudePermissionMode, string> = {
  auto: "⏵⏵ auto mode on (shift+tab to cycle)",
  acceptEdits: "⏵⏵ accept edits on (shift+tab to cycle)",
  plan: "⏸ plan mode on (shift+tab to cycle)",
  bypassPermissions: "⏵⏵ bypass permissions on (shift+tab to cycle)",
  manual: "⏸ manual mode on (shift+tab to cycle)",
  dontAsk: "",
};

/**
 * A pane whose Shift+Tab walks `cycle`, starting at its first mode. `lag` reads show the old footer
 * after each press, the way a redraw trails the key.
 */
function cyclingPane(cycle: ClaudePermissionMode[], options: { lag?: number; stuck?: boolean } = {}) {
  let at = 0;
  let stale = 0;
  const fake = runtime({
    screen: async () => {
      if (stale > 0) {
        stale -= 1;
        return screenWith(["hello"], undefined, FOOTERS[cycle[(at - 1 + cycle.length) % cycle.length]!]);
      }
      return screenWith(["hello"], undefined, FOOTERS[cycle[at]!]);
    },
    send: async (_pane, bytes) => {
      fake.sent.push(new TextDecoder().decode(bytes));
      if (options.stuck) return;
      at = (at + 1) % cycle.length;
      stale = options.lag ?? 0;
    },
  });
  return fake;
}

const noWait = async () => {};
const SHIFT_TAB = "\u001b[Z";

describe("setting a terminal session's permission mode", () => {
  test("presses Shift+Tab until the footer names the mode, and no further", async () => {
    const pane = cyclingPane(["auto", "acceptEdits", "plan", "manual"], { lag: 2 });
    expect(await setTmuxPermissionMode("s1", "plan", pane, noWait)).toEqual({ ok: true, mode: "plan" });
    expect(pane.sent).toEqual([SHIFT_TAB, SHIFT_TAB]);
  });

  test("presses nothing when the session is already in that mode", async () => {
    const pane = cyclingPane(["auto", "plan"]);
    expect(await setTmuxPermissionMode("s2", "auto", pane, noWait)).toEqual({ ok: true, mode: "auto" });
    expect(pane.sent).toEqual([]);
  });

  test("stops back where it started when the cycle never reaches the mode", async () => {
    const pane = cyclingPane(["auto", "acceptEdits", "plan"]);
    const outcome = await setTmuxPermissionMode("s3", "bypassPermissions", pane, noWait);
    expect(outcome).toMatchObject({ ok: false, reason: "unreachable", mode: "auto" });
    expect(outcome.ok ? "" : outcome.message).toContain("never reaches bypass");
    expect(pane.sent).toHaveLength(3);
  });

  test("gives up when a press does not move the footer", async () => {
    const pane = cyclingPane(["auto", "plan"], { stuck: true });
    expect(await setTmuxPermissionMode("s4", "plan", pane, noWait)).toMatchObject({
      ok: false,
      reason: "no-response",
      mode: "auto",
    });
    expect(pane.sent).toEqual([SHIFT_TAB]);
  });

  test("presses nothing when no footer names a mode", async () => {
    const pane = runtime({ screen: async () => screenWith(["hello"], undefined, "") });
    expect(await setTmuxPermissionMode("s5", "plan", pane, noWait)).toMatchObject({ ok: false, reason: "no-footer" });
    expect(pane.sent).toEqual([]);
  });

  test("answers a session with no pane, and one tmux will not read", async () => {
    expect(await setTmuxPermissionMode("s6", "plan", runtime({ pane: async () => null }), noWait)).toMatchObject({
      ok: false,
      reason: "no-pane",
    });
    const broken = runtime({
      screen: async () => {
        throw new TmuxUnavailable("gone");
      },
    });
    expect(await setTmuxPermissionMode("s7", "plan", broken, noWait)).toMatchObject({
      ok: false,
      reason: "tmux-unavailable",
    });
  });
});
