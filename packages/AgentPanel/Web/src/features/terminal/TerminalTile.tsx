import { useCallback, useState } from "react";
import type { AgentTerminalContext, TmuxSessionSummary } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "../activity-feed/data-source/SidecarDataSource";
import { useAgentTerminal, type AgentTerminalState } from "./useAgentTerminal";

/**
 * One terminal in the wall, at a grid it does not renegotiate.
 *
 * Eighty columns because that is what the programs inside a tmux session are written for, and
 * because a tile that measured itself would push its own size onto the PTY -- and through it onto
 * whatever terminal the user has the same tmux session open in.
 */
const TILE_COLUMNS = 80;
const TILE_ROWS = 24;

export function TerminalTile({ feed, session }: {
  feed: SidecarDataSource;
  session: TmuxSessionSummary;
}) {
  const [state, setState] = useState<AgentTerminalState | null>(null);
  const context: AgentTerminalContext = { kind: "tmux", session: session.name };
  const onState = useCallback((_context: AgentTerminalContext, next: AgentTerminalState) => {
    setState(next);
  }, []);
  const { mountRef, labels } = useAgentTerminal({
    feed,
    context,
    sizing: { kind: "fixed", columns: TILE_COLUMNS, rows: TILE_ROWS },
    onState,
  });

  return (
    <section
      aria-label={`${session.name} terminal`}
      className="flex w-fit flex-col overflow-hidden rounded border border-border bg-white dark:bg-[#0b0e14]"
    >
      <header className="flex min-h-6 shrink-0 items-center justify-between gap-2 border-b border-border px-2 font-mono text-[10px]">
        <span className="truncate font-semibold">{session.name}</span>
        <span className="shrink-0 text-muted-foreground">
          {session.attachedClients > 0 ? `${session.attachedClients} watching` : "unattached"}
        </span>
      </header>
      <div ref={mountRef} className="p-1" />
      <footer className="flex min-h-5 shrink-0 items-center gap-2 overflow-hidden border-t border-border px-2 font-mono text-[10px] text-muted-foreground">
        <span className="truncate">
          {state?.kind === "error"
            ? state.message
            : state?.kind === "ended"
              ? "attach ended"
              // Before the first checkpoint the sync label still says "Opening terminal", which is
              // no longer true once the attach has answered: a fresh tmux client has no history to
              // replay, so it paints as ordinary output and no checkpoint ever arrives.
              : state?.kind === "ready" && labels.sync === "Opening terminal"
                ? "attached"
                : labels.sync}
        </span>
      </footer>
    </section>
  );
}
