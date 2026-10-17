// Whether a Claude Code session is running as a CLI process, and in which tmux pane.
//
// Read-only, and it reads nothing of Claude Code's but the session registry row, verified against
// the kernel by `sessionOwner`. This module used to put a turn into such a session through the
// harness's per-session messaging socket, which meant reading the session's messaging key out of
// Claude Code's registry too; that was removed on 2026-10-16 (see `wire/cliSession.ts`). The panel
// asks this to decide which composer a session gets: a terminal session has no window field to
// mirror, and is typed into through its tmux pane when it has one.

import type { CliSessionStatus } from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import type { CommandRunner } from "@/tasks/processProbe";
import { currentProcessTable, runCommand } from "@/tasks/processProbe";
import { liveSessionProcesses, sessionOwner } from "@/tasks/sessionRegistry";

export async function cliSessionStatus(
  sessionId: string,
  run: CommandRunner = runCommand,
  sessionsDirectory: string = config.claudeSessionsDirectory,
): Promise<CliSessionStatus> {
  const table = await currentProcessTable(run);
  const owner = await sessionOwner(sessionId, table, sessionsDirectory);
  const live = (await liveSessionProcesses(table, sessionsDirectory)).filter((entry) => entry.sessionId === sessionId);
  return { entrypoint: owner?.entrypoint ?? null, tmuxSession: owner?.tmuxSession ?? null, liveProcesses: live.length };
}
