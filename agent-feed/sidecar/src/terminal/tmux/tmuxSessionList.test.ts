// Which joined pane gets its exited command run again: only one this sidecar started for the
// session, and only once nothing is running under its shell.

import { expect, test } from "bun:test";
import { reviveExitedPane } from "@/terminal/tmux/tmuxSessionList";

const SESSION_ID = "ses_abc123XYZ";
const REVIVAL = { startedFor: SESSION_ID, cwd: "/repo", command: ["/opt/opencode", "--session", SESSION_ID] };

function steps(starts: { pane: string; command: string }[], exited: boolean) {
  const respawned: { pane: string; cwd: string; command: readonly string[] }[] = [];
  return {
    respawned,
    steps: {
      paneStarts: async () => starts,
      exited: async () => exited,
      respawn: async (pane: string, cwd: string, command: readonly string[]) => {
        respawned.push({ pane, cwd, command });
      },
    },
  };
}

test("runs the session's TUI again in its own pane once the TUI has exited", async () => {
  const { respawned, steps: tmux } = steps(
    [{ pane: "%4", command: `/bin/zsh -l -c 'opencode' '--session' '${SESSION_ID}'; exec /bin/zsh -l` }],
    true,
  );

  expect(await reviveExitedPane("donald", REVIVAL, tmux)).toBe(true);
  expect(respawned).toEqual([{ pane: "%4", cwd: "/repo", command: REVIVAL.command }]);
});

test("leaves a pane alone while something still runs under its shell", async () => {
  // The case that matters: a TUI somebody opened by hand at the pane's prompt, on any session.
  const { respawned, steps: tmux } = steps(
    [{ pane: "%4", command: `/bin/zsh -l -c 'opencode' '--session' '${SESSION_ID}'` }],
    false,
  );

  expect(await reviveExitedPane("diana", REVIVAL, tmux)).toBe(false);
  expect(respawned).toEqual([]);
});

test("never respawns a pane it did not start for this session", async () => {
  // A person's own tmux session carries the stamp too once a viewer joins it, and `respawn-pane
  // -k` there would end their shell.
  const { respawned, steps: tmux } = steps([{ pane: "%1", command: "/bin/zsh -l" }], true);

  expect(await reviveExitedPane("work", REVIVAL, tmux)).toBe(false);
  expect(respawned).toEqual([]);
});
