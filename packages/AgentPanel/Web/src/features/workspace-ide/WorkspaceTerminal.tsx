// The IDE's lower pane: one shell, in the workspace the reader is browsing.
//
// It used to be `TerminalsSurface`, the wall of every tmux session on the machine, which answers a
// different question from the one this pane asks. A reader with a file open wants to run `git log`
// or `bun test` in ITS directory; the wall is a grid of 80x24 tiles onto sessions somebody else
// started, and none of them is that. This is the panel's own PTY session instead -- owned by
// whoever opened it, in the workspace root, and started by opening it. The shell itself is
// `ShellTerminal`, which the tab bar's machine terminal draws too.

import { useMemo } from "react";
import type { AgentTerminalContext } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { ShellTerminal } from "@/features/terminal/ShellTerminal";

export function WorkspaceTerminal({
  feed,
  workspaceName,
  workspacePath,
}: {
  feed: SidecarDataSource;
  /** What the roster calls this workspace, which is what a reader recognises the pane by. */
  workspaceName: string;
  /** The workspace root. The shell's cwd, and what its PTY session is named after. */
  workspacePath: string;
}) {
  const context = useMemo<AgentTerminalContext>(() => ({ kind: "workspace", workspacePath }), [workspacePath]);
  return <ShellTerminal feed={feed} context={context} label={`${workspaceName} terminal`} where={workspacePath} />;
}
