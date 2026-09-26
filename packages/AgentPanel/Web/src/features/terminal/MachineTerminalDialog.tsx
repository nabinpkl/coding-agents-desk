// A shell on one machine, over whatever surface the reader is on.
//
// Opened from the terminal button beside each machine in the tab bar. It is the machine's own
// login shell in its home directory, so it is a place to run a command on that machine without
// first finding a workspace or a session there. What carries it is the machine's answer, not the
// panel's guess (`SidecarConfig.machineShell`): tmux on every machine, asked before the shell
// mounts because a tmux pane is viewed differently from the first byte. The PTY arm below stays
// for sidecars older than the switch, which still answer it.
//
// Closing ENDS the shell, after asking. There is no hide: a shell left running behind a closed
// dialog is one nobody can see and everybody pays for, so leaving means the work in it stops, and
// the confirmation is where the reader decides that.

import { LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  MACHINE_SHELL_SESSION,
  type AgentTerminalDescriptor,
  type AgentTerminalContext,
  type MachineShellBackend,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { ShellTerminal } from "@/features/terminal/ShellTerminal";
import type { AgentTerminalState } from "@/features/terminal/useAgentTerminal";

export interface MachineTerminalTarget {
  /** What the tab bar calls the machine. */
  label: string;
  /** That machine's sidecar, which is what makes the shell land there and not here. */
  feed: SidecarDataSource;
}

type Phase = "open" | "confirming" | "ending";

export function MachineTerminalDialog({ machine, onClose }: {
  machine: MachineTerminalTarget;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const opener = useRef<Element | null>(null);
  const [via, setVia] = useState<MachineShellBackend | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("open");
  const descriptor = useRef<AgentTerminalDescriptor | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Back to the button that opened it, so a keyboard reader is not dropped at the top of the page.
  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    machine.feed.fetchConfig()
      .then((config) => {
        if (!cancelled) setVia(config.machineShell);
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(`Could not ask ${machine.label} how to open a shell: ${String((error as Error).message ?? error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [machine]);

  const context = useMemo<AgentTerminalContext | null>(
    () => (via ? { kind: "machine", via } : null),
    [via],
  );

  const onState = (state: AgentTerminalState): void => {
    if (state.kind === "ready") descriptor.current = state.descriptor;
    // The shell is gone, whether this dialog ended it or it exited on its own: nothing is left to
    // show. While ending, this is the confirmation that it worked.
    if (state.kind === "ended" && phaseRef.current === "ending") closeRef.current();
    if (state.kind === "error" && phaseRef.current === "ending") closeRef.current();
  };

  const end = async (): Promise<void> => {
    setPhase("ending");
    setProblem(null);
    try {
      if (via === "tmux") {
        // The owner's own verb for ending a tmux session. The viewer's goodbye never ends one.
        // Closed on its answer rather than on the stream, because a tmux viewer is a pipe on the
        // pane and hears nothing when the pane goes: measured on a peer, the session was gone and
        // the dialog sat on "Ending" with no ended state ever arriving.
        await machine.feed.killTmuxSession(MACHINE_SHELL_SESSION);
        closeRef.current();
      } else if (descriptor.current) {
        await machine.feed.closeTerminal(descriptor.current.terminalId, "kill");
      } else {
        // Nothing opened, so nothing is running to end.
        closeRef.current();
      }
    } catch (error) {
      setProblem(`The shell did not end: ${String((error as Error).message ?? error)}`);
      setPhase("open");
    }
  };

  const askToEnd = (): void => {
    if (phaseRef.current === "open") setPhase("confirming");
  };

  // A portal and a plain overlay rather than `<dialog>` with `showModal`, and the reason is Escape.
  // A shell needs it -- vim, a pager, a readline edit -- and a modal dialog treats it as "close".
  // Cancelling that works once: Chrome's close watcher lets a page refuse the second Escape only
  // after a fresh user activation, so a reader pressing Escape twice in vim would lose the shell.
  // Nothing here listens for Escape at all; the end button and the backdrop are the ways out, and
  // both ask first.
  return createPortal(
    <div
      className="fixed inset-0 z-60 flex items-stretch justify-center bg-black/45 sm:items-center sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) askToEnd();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="machine-terminal-title"
        className="flex h-dvh w-full flex-col overflow-hidden bg-card text-foreground shadow-2xl
          sm:h-[min(80dvh,760px)] sm:max-w-5xl sm:rounded-xl sm:border sm:border-border"
      >
        <header className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border pr-1 pl-3">
          <h2
            id="machine-terminal-title"
            className="min-w-0 flex-1 truncate text-(length:--agent-panel-fs-sidebar-meta,13px) font-semibold"
          >
            Terminal on {machine.label}
          </h2>
          {phase === "open" ? (
            <button
              type="button"
              onClick={askToEnd}
              aria-label={`End the terminal on ${machine.label}`}
              title="End this shell"
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
            >
              <X className="size-4" aria-hidden />
            </button>
          ) : (
            <div role="group" aria-label="End this shell?" className="flex shrink-0 items-center gap-2">
              <span className="text-(length:--agent-panel-fs-sidebar-chip,11px) text-muted-foreground">
                End the shell? Anything running in it stops.
              </span>
              <button
                type="button"
                onClick={() => setPhase("open")}
                disabled={phase === "ending"}
                className="min-h-8 cursor-pointer rounded-md px-3 text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Keep
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => void end()}
                disabled={phase === "ending"}
                className="flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md bg-destructive px-3 text-(length:--agent-panel-fs-sidebar-chip,11px) font-semibold text-white outline-none transition-colors hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 active:bg-destructive/80 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {phase === "ending" ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : null}
                {phase === "ending" ? "Ending…" : "End shell"}
              </button>
            </div>
          )}
        </header>
        {problem ? (
          <p role="alert" className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-destructive">
            {problem}
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          {context ? (
            <ShellTerminal
              feed={machine.feed}
              context={context}
              label={`${machine.label} terminal`}
              where={`~ on ${machine.label}${via === "tmux" ? " (tmux)" : ""}`}
              onState={onState}
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
