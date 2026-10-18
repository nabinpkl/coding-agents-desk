// The windows and panes standing inside one tmux session, shared by the roster row and
// the strip card so the two never disagree about what is open or what is active.
//
// Progressive disclosure, not a tree for its own sake: a session with one window renders
// nothing here -- its own row already opens that window -- and a window with one pane renders
// no pane rows either. Only a session like `harbor`, with four windows of three panes, grows
// the extra levels, which is exactly the session whose windows were unreachable before.
//
// Keys are the canvas's own open keys (`machine:session:window[.pane]`), so toggling a row
// opens and closes the same tile the strip draws: the row and the tile cannot disagree.

import { ChevronDown } from "lucide-react";
import { useState } from "react";
import type { TmuxSessionSummary } from "@agentdesk/agent-feed-wire";
import { terminalPaneKey, terminalWindowKey, tmuxTarget } from "@/features/terminal/canvas/terminalGroups";

export function TerminalWindowRows({
  machineId,
  session,
  openKeys,
  onToggleKey,
}: {
  machineId: string | undefined;
  session: TmuxSessionSummary;
  /** Every open tile key, sessions and windows and panes alike: membership is the open state. */
  openKeys: ReadonlySet<string>;
  /** Flips one key's membership. The shell's child toggle already takes any key. */
  onToggleKey: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (session.windowList.length <= 1) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setExpanded((on) => !on)}
        aria-expanded={expanded}
        aria-label={`${session.windowList.length} windows in ${session.name}`}
        className="flex min-h-7 w-full cursor-pointer items-center gap-1 rounded-md px-2 text-left text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
      >
        <ChevronDown className={`size-3.5 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`} aria-hidden />
        {session.windowList.length} windows
        {session.windowList.some((window) => window.active)
          ? ` · ${session.windowList.find((window) => window.active)!.index} active`
          : null}
      </button>
      {expanded ? (
        <ul role="list" aria-label={`${session.name} windows`} className="mt-0.5 space-y-0.5">
          {session.windowList.map((window) => {
            const key = terminalWindowKey(machineId, session.name, window.index);
            const open = openKeys.has(key);
            return (
              <TerminalWindowRow
                key={key}
                machineId={machineId}
                sessionName={session.name}
                windowIndex={window.index}
                windowName={window.name}
                active={window.active}
                paneCount={window.panes.length}
                activeCommand={window.panes.find((pane) => pane.active)?.command}
                open={open}
                onToggle={() => onToggleKey(key)}
                openKeys={openKeys}
                onToggleKey={onToggleKey}
                panes={window.panes}
              />
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function TerminalWindowRow({
  machineId,
  sessionName,
  windowIndex,
  windowName,
  active,
  paneCount,
  activeCommand,
  open,
  onToggle,
  openKeys,
  onToggleKey,
  panes,
}: {
  machineId: string | undefined;
  sessionName: string;
  windowIndex: number;
  windowName: string;
  active: boolean;
  paneCount: number;
  activeCommand: string | undefined;
  open: boolean;
  onToggle: () => void;
  openKeys: ReadonlySet<string>;
  onToggleKey: (key: string) => void;
  panes: TmuxSessionSummary["windowList"][number]["panes"];
}) {
  const [panesOpen, setPanesOpen] = useState(false);
  const target = tmuxTarget(sessionName, windowIndex);
  return (
    <li className="rounded-md border border-border/60">
      <div className="flex items-center gap-1 pr-1">
        {paneCount > 1 ? (
          <button
            type="button"
            onClick={() => setPanesOpen((on) => !on)}
            aria-expanded={panesOpen}
            aria-label={`${paneCount} panes in ${target}`}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ChevronDown className={`size-3.5 transition-transform ${panesOpen ? "" : "-rotate-90"}`} aria-hidden />
          </button>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          aria-current={open ? "page" : undefined}
          title={`Open ${target}${active ? " (active window)" : ""}`}
          className="flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
        >
          {active ? (
            <span
              aria-label="Active window"
              title="Active window"
              className="size-2 shrink-0 rounded-full bg-green-500"
            />
          ) : (
            <span aria-hidden className="size-2 shrink-0 rounded-full border border-border" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-(length:--agent-panel-fs-sidebar-meta,13px) font-medium text-foreground">
              {windowIndex}:{windowName}
            </span>
            <span className="block truncate text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
              {active ? "active" : `window ${windowIndex}`}
              {paneCount > 1 ? ` · ${paneCount} panes` : ""}
              {activeCommand ? ` · ${activeCommand}` : ""}
            </span>
          </span>
        </button>
      </div>
      {panesOpen && paneCount > 1 ? (
        <ul role="list" aria-label={`${target} panes`} className="space-y-0.5 px-1 pt-0.5 pb-1 pl-8">
          {panes.map((pane) => {
            const paneKey = terminalPaneKey(machineId, sessionName, windowIndex, pane.index);
            const paneOpen = openKeys.has(paneKey);
            const paneTarget = tmuxTarget(sessionName, windowIndex, pane.index);
            return (
              <li key={paneKey}>
                <button
                  type="button"
                  onClick={() => onToggleKey(paneKey)}
                  aria-current={paneOpen ? "page" : undefined}
                  title={`Open ${paneTarget}${pane.active ? " (active pane)" : ""}`}
                  className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
                >
                  {pane.active ? (
                    <span
                      aria-label="Active pane"
                      title="Active pane"
                      className="size-1.5 shrink-0 rounded-full bg-green-500"
                    />
                  ) : (
                    <span aria-hidden className="size-1.5 shrink-0 rounded-full border border-border" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-(length:--agent-panel-fs-sidebar-chip,11px) text-foreground">
                    pane {pane.index} · {pane.command || "shell"}
                    <span className="text-muted-foreground">
                      {" · "}
                      {pane.path.split("/").filter(Boolean).at(-1) || pane.path}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
