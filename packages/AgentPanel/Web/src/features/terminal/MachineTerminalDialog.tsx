// A shell on one machine, over whatever surface the reader is on.
//
// Opened from the terminal button beside each machine in the tab bar. It is the machine's own
// login shell in its home directory -- a PTY session of the panel's, not a tmux pane -- so it is a
// place to run a command on that machine without first finding a workspace or a session there.
//
// Closing it detaches rather than ends: the PTY session outlives its viewer, so reopening the same
// machine lands back in the shell that was left, with its history and its working directory.

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { AgentTerminalContext } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { ShellTerminal } from "@/features/terminal/ShellTerminal";

/** The one context this dialog opens, shared so the terminal never re-attaches on a render. */
const MACHINE_SHELL: AgentTerminalContext = { kind: "machine" };

export interface MachineTerminalTarget {
  /** What the tab bar calls the machine. */
  label: string;
  /** That machine's sidecar, which is what makes the shell land there and not here. */
  feed: SidecarDataSource;
}

export function MachineTerminalDialog({ machine, onClose }: {
  machine: MachineTerminalTarget;
  onClose: () => void;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const opener = useRef<Element | null>(null);

  // Back to the button that opened it, so a keyboard reader is not dropped at the top of the page.
  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  // A portal and a plain overlay rather than `<dialog>` with `showModal`, and the reason is Escape.
  // A shell needs it -- vim, a pager, a readline edit -- and a modal dialog treats it as "close".
  // Cancelling that works once: Chrome's close watcher lets a page refuse the second Escape only
  // after a fresh user activation, so a reader pressing Escape twice in vim would lose the shell.
  // Nothing here listens for Escape at all; the close button and the backdrop are the ways out.
  return createPortal(
    <div
      className="fixed inset-0 z-60 flex items-stretch justify-center bg-black/45 sm:items-center sm:p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
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
          <button
            type="button"
            onClick={() => closeRef.current()}
            aria-label={`Close the terminal on ${machine.label}`}
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <ShellTerminal
            feed={machine.feed}
            context={MACHINE_SHELL}
            label={`${machine.label} terminal`}
            where={`~ on ${machine.label}`}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
