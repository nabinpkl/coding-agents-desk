// A login shell of the panel's own, drawn flush to whatever box it is given.
//
// Two places open one: the IDE's lower pane, in the workspace being browsed, and the tab bar's
// machine terminal, in a machine's home. Both are shells nobody else is watching rather than a pane
// somebody started, so the grid follows the box and a keyboard with no Ctrl, Esc or arrows gets the
// key rail. What differs is what the shell is pointed at -- including, for a machine with no PTY
// manager, a tmux session the context names -- and where it says it is, which the props carry.
//
// It holds no size of its own. Each caller already decides how big the box is -- the IDE with its
// divider, the dialog with its frame -- and a second handle on the terminal inside it would be two
// controls for one height, which is why `AgentTerminalPane` is not reused here despite rendering
// the same hook.

import { useCallback, useState } from "react";
import type { AgentTerminalContext } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { drawsOwnKeyboard } from "@/features/keyboard/softwareKeyboard";
import { TerminalKeyRail } from "@/features/terminal/TerminalKeyRail";
import { useAgentTerminal, type AgentTerminalState } from "@/features/terminal/useAgentTerminal";
import { useLatestRef } from "@/hooks/useLatestRef";

export function ShellTerminal({
  feed,
  context,
  label,
  where,
  onState: reportState,
}: {
  feed: SidecarDataSource;
  /**
   * What the shell is pointed at. Must be stable by identity: the hook tears the terminal down and
   * re-attaches when this changes, so a fresh object every render would do that on every render.
   */
  context: AgentTerminalContext;
  /** The region's accessible name, which is what a reader recognises the terminal by. */
  label: string;
  /** Where the shell is, shown in the footer, because a shell's whole identity is where it is. */
  where: string;
  /** What the hook reports, for a caller that acts on the shell rather than only showing it. */
  onState?: (state: AgentTerminalState) => void;
}) {
  // Kept here because the hook only REPORTS a failed open or an ended shell; its own status label
  // stays on "Opening terminal" forever, which is a sidecar with no PTY manager reading as a slow one.
  const [problem, setProblem] = useState<string | null>(null);
  // Read through a ref so a caller's inline callback does not re-attach the terminal every render:
  // the hook tears down and reopens whenever `onState` changes by identity.
  const report = useLatestRef(reportState);
  const onState = useCallback(
    (_context: AgentTerminalContext, state: AgentTerminalState) => {
      if (state.kind === "error") setProblem(state.message);
      else if (state.kind === "ended") setProblem("The shell exited");
      else setProblem(null);
      report.current?.(state);
    },
    [report],
  );
  const { mountRef, labels, focused, modifiers, toggleModifier, pressKey } = useAgentTerminal({
    feed,
    context,
    onState,
    // The grid follows the box. Nothing else is watching this shell -- it is this panel's own
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
    // Its own key rail stands under it, so the keyboard bar does not stand on the keyboard too.
    <section aria-label={label} data-keyboard-bar="off" className="flex h-full min-h-0 flex-col">
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
      {showsKeyRail ? <TerminalKeyRail modifiers={modifiers} onModifier={toggleModifier} onKey={pressKey} /> : null}
      <footer
        className="flex min-h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-border
          px-2 font-mono text-[10px] text-muted-foreground"
      >
        {problem ? (
          <span role="alert" className="min-w-0 truncate text-destructive">
            {problem}
          </span>
        ) : (
          <span className="shrink-0">{labels.sync}</span>
        )}
        {/* The directory, because a shell's whole identity is where it is. Trailing rather than
            leading so the status, which changes, keeps the edge the eye returns to -- and it is
            the half that gives way on a phone, where the status is short enough to always fit.
            Truncated rather than reversed with `dir="rtl"`: that keeps the informative tail but
            moves the leading slash to the other end, so the path stops being one a reader can
            copy by eye. */}
        <span className="ml-auto min-w-0 truncate">{where}</span>
      </footer>
    </section>
  );
}
