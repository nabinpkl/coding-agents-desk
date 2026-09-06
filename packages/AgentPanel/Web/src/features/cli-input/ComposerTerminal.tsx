import { useCallback, useMemo, useState } from "react";
import type { AgentTerminalContext } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../activity-feed/data-source/SidecarDataSource";
import { useAgentTerminal, type AgentTerminalState } from "../terminal/useAgentTerminal";

/**
 * The composer as the session's own terminal, rather than a text field beside it.
 *
 * What this buys over a field: everything the session's renderer draws is visible while you type,
 * and every key reaches it. A field can send text and a newline; it cannot send ctrl-c to stop a
 * run, escape to dismiss, shift-tab to cycle a permission mode, or the arrows that move through a
 * composer's history. Those are the keys you reach for when a session needs steering rather than
 * a new instruction, which is most of the time you are looking at one.
 *
 * It fits the composer band rather than the terminals wall, so it is short and it FOLLOWS the band
 * instead of pinning a grid: a fixed 80x24 here would resize the pane in whoever else's terminal
 * has that session open, for a strip that is a few rows tall.
 */
export function ComposerTerminal({
  feed,
  session,
  rows,
}: {
  feed: SidecarDataSource;
  session: string;
  rows: number;
}) {
  const [state, setState] = useState<AgentTerminalState | null>(null);
  const context = useMemo<AgentTerminalContext>(() => ({ kind: "tmux", session }), [session]);
  const onState = useCallback((_context: AgentTerminalContext, next: AgentTerminalState) => {
    setState(next);
  }, []);
  const { mountRef } = useAgentTerminal({ feed, context, sizing: { kind: "fit" }, onState });

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div
        ref={mountRef}
        // Height in rows rather than pixels so it stays whole lines at any font size, which is what
        // keeps the last line from being a sliver the reader cannot tell is there.
        style={{ height: `calc(${rows} * 1.08 * 13px + 0.5rem)` }}
        className="min-w-0 overflow-hidden rounded-xl border border-border bg-[#0b0e14] px-1 py-1"
        aria-label={`Terminal for tmux session ${session}`}
      />
      {state?.kind === "error" ? (
        <p className="px-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-destructive">
          {state.message}
        </p>
      ) : state?.kind === "ended" ? (
        <p className="px-1 text-(length:--agent-panel-fs-sidebar-meta,13px) text-muted-foreground">
          Terminal ended.
        </p>
      ) : null}
    </div>
  );
}
