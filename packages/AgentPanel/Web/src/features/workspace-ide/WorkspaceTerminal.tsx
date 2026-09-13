// The IDE's lower pane: one shell, in the workspace the reader is browsing.
//
// It used to be `TerminalsSurface`, the wall of every tmux session on the machine, which answers a
// different question from the one this pane asks. A reader with a file open wants to run `git log`
// or `bun test` in ITS directory; the wall is a grid of 80x24 tiles onto sessions somebody else
// started, and none of them is that. This is the panel's own PTY session instead -- owned by
// whoever opened it, in the workspace root, and started by opening it.
//
// It holds no size of its own. The IDE already has a divider above it that decides how tall the
// pane is, and a second handle on the terminal inside it would be two controls for one height --
// which is why `AgentTerminalPane` is not reused here despite rendering the same hook.

import { useMemo, useState } from "react";
import type { AgentTerminalContext } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { drawsOwnKeyboard } from "@/features/keyboard/softwareKeyboard";
import { TerminalKeyRail } from "@/features/terminal/TerminalKeyRail";
import { useAgentTerminal } from "@/features/terminal/useAgentTerminal";

export function WorkspaceTerminal({ feed, workspaceName, workspacePath }: {
  feed: SidecarDataSource;
  /** What the roster calls this workspace, which is what a reader recognises the pane by. */
  workspaceName: string;
  /** The workspace root. The shell's cwd, and what its PTY session is named after. */
  workspacePath: string;
}) {
  // Memoised because the hook tears the terminal down and re-attaches when its context changes by
  // identity, and a fresh object every render would do that on every render.
  const context = useMemo<AgentTerminalContext>(
    () => ({ kind: "workspace", workspacePath }),
    [workspacePath],
  );
  const { mountRef, labels, focused, modifiers, toggleModifier, pressKey } = useAgentTerminal({
    feed,
    context,
    // The grid follows the pane. Nothing else is watching this shell -- it is this panel's own
    // PTY session rather than a pane somebody has open in a terminal app -- so taking the box's
    // shape costs nobody their screen.
    sizing: { kind: "fit" },
  });
  // Read once per mount rather than at import: a browser does not grow a software keyboard part
  // way through a session, but a test has to be able to say which kind of browser it is.
  const [softwareKeyboard] = useState(drawsOwnKeyboard);
  // Only while a keyboard with no Ctrl, Esc or arrows is actually up. A desktop browser has them.
  const showsKeyRail = focused && softwareKeyboard;

  return (
    <section aria-label={`${workspaceName} terminal`} className="flex h-full min-h-0 flex-col">
      {/* The screen, filling the pane, flush to its edges.

          No padding on this box and none on the screen inside it, and neither is a style choice.
          `proposedDimensions` divides `mount.clientHeight` -- which INCLUDES this box's own padding
          -- by the cell, and subtracts only the padding on the terminal element. So padding here
          buys a grid taller than the box: measured at a 274px pane as 17 rows in room for 16, with
          the last one below the bottom edge. And padding on the terminal element, which the fit
          does subtract, is painted black in light mode, because xterm's own stylesheet gives
          `.xterm-viewport` an opaque `#000` for its scrollbar and the viewport is inset to the
          PADDING box while the rows that paint over it are inset to the content box. Flush avoids
          both, and an IDE terminal running to the edge of its pane is what one looks like anyway. */}
      <div ref={mountRef} className="min-h-0 flex-1 overflow-auto bg-white dark:bg-[#0b0e14]" />
      {showsKeyRail
        ? <TerminalKeyRail modifiers={modifiers} onModifier={toggleModifier} onKey={pressKey} />
        : null}
      <footer
        className="flex min-h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-border
          px-2 font-mono text-[10px] text-muted-foreground"
      >
        <span className="shrink-0">{labels.sync}</span>
        {/* The directory, because a shell's whole identity is where it is. Trailing rather than
            leading so the status, which changes, keeps the edge the eye returns to -- and it is
            the half that gives way on a phone, where the status is short enough to always fit.
            Truncated rather than reversed with `dir="rtl"`: that keeps the informative tail but
            moves the leading slash to the other end, so the path stops being one a reader can
            copy by eye. */}
        <span className="ml-auto min-w-0 truncate">{workspacePath}</span>
      </footer>
    </section>
  );
}
