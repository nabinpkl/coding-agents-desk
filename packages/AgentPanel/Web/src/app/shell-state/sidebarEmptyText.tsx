// What the main column says when the chosen sidebar view has nothing to show it.
//
// The Messages view is the exception that proves the rule: its content lives in the sidebar, so
// the column says where rather than repeating it. Keeping that sentence here rather than inline
// in the shell is what keeps the shell's own file from growing a branch per sidebar view.

import type { ReactElement } from "react";
import type { AgentSidebarMode } from "@/features/sidebar/AgentSidebar";

const NO_THREAD: Record<AgentSidebarMode, string | null> = {
  sessions: "Select a session from Sessions",
  bots: null,
  canvas: null,
  messages: "Threads with your agents live in the Messages tab",
};

export function sidebarEmptyText(mode: AgentSidebarMode): string | null {
  return NO_THREAD[mode] ?? null;
}

/** The centered sentence the main column shows when the chosen view has nothing to show it. */
export function EmptyThread({ text }: { text: string }): ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-(length:--agent-panel-fs-sidebar-body,15px) text-muted-foreground">
      {text}
    </div>
  );
}
