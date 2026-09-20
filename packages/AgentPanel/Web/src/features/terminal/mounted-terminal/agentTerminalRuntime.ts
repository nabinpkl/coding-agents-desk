// What one mounted terminal is holding while its stream and its fit both read it.
//
// Built inside the mount effect and handed to both parts, so neither keeps a second copy
// of a fact the other writes -- which pane shape is authoritative, what the base cell
// measured, and whether the far end has already closed.

import type { Terminal as XtermTerminal } from "@xterm/xterm";
import type { Dimensions, AgentTerminalState } from "@/features/terminal/mounted-terminal/agentTerminalTypes";
import type { TerminalMouseMode } from "@/features/terminal/mounted-terminal/terminalMouseMode";

export interface TerminalRuntime {
  readonly terminal: XtermTerminal;
  readonly mount: HTMLDivElement;
  readonly zoomRef: { current: number | null };

  /** Measured once, at the base size; everything after that is arithmetic. */
  baseCell: { width: number; height: number } | null;
  /**
   * What the program in the pane wants the mouse for, learned from the stream.
   *
   * Shared rather than copied because two readers need it: the wheel binding asks it on every
   * event, and the stream re-asserts it into xterm after each checkpoint clears it.
   */
  mouseMode: TerminalMouseMode;
  /** Whether this viewer decides the pane's grid, or merely scales its type to fit. */
  ownsPaneShape: boolean;
  adoptsPaneShape: boolean;
  paneAuthoritative: boolean;
  remoteClosed: boolean;
  unsubscribe: (() => void) | null;
  dimensions: Dimensions | null;
  moved: boolean;

  readonly enqueueWrite: (operation: () => void | Promise<void>) => void;
  readonly write: (encoded: string) => void;
  readonly scheduleViewport: () => void;
  readonly finishRemote: (state: AgentTerminalState) => void;
  readonly fail: (error: unknown) => void;
  /** Re-scales the type for the pane's current shape. Assigned once both parts exist. */
  fitType: () => void;
  readonly setContentHeight: (height: number | null) => void;
  readonly setFontSize: (size: number) => void;
  readonly setOwnershipLabel: (label: string) => void;
  readonly setSourceLabel: (label: string) => void;
  readonly setSyncLabel: (label: string) => void;
  readonly setViewLabel: (label: string) => void;
}
