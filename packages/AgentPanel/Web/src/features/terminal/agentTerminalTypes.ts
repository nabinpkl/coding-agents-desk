// What a mounted terminal is, and what a caller may ask of it.

import type { RefObject } from "react";
import type { AgentTerminalDescriptor } from "@agentdesk/agent-feed-wire";
import type { RailKey, RailModifier } from "@agentdesk/agent-feed-wire";
import type { ModifierState } from "../keyboard/modifierLatch";

/**
 * A live terminal, and the chrome-facing handles for driving it from outside the grid.
 *
 * `modifiers` and `pressKey` exist for the key rail: a phone keyboard has no Ctrl, Esc, Tab or
 * arrows, so those keys are drawn beside the terminal and typed through here. They live on the
 * hook rather than in the rail because a held modifier has to reach `onData` -- the rail supplies
 * the Ctrl, the phone's own keyboard supplies the letter, and only this side sees both.
 */
export interface AgentTerminal {
  mountRef: RefObject<HTMLDivElement | null>;
  labels: TerminalLabels;
  /**
   * How tall this terminal's screen wants to be, or null until one is attached and measured.
   *
   * Only meaningful where the far end owns the grid: it is the height at which the type fills the
   * width the screen has, which is the height a pane free to choose its own should take. Capped by
   * whoever takes it -- this is what the screen wants, not what the surface can afford.
   */
  contentHeight: number | null;
  /** The type size on screen right now, whether the fit chose it or the reader did. */
  fontSize: number | null;
  /** Whether this terminal is what the keyboard is typing into. */
  focused: boolean;
  modifiers: Record<RailModifier, ModifierState>;
  toggleModifier: (modifier: RailModifier) => void;
  pressKey: (key: RailKey) => void;
}

export type AgentTerminalState =
  | { kind: "ready"; descriptor: AgentTerminalDescriptor }
  | { kind: "error"; message: string }
  | { kind: "ended"; exitStatus?: number };

/**
 * How the terminal decides its own grid.
 *
 * `fit` measures the mount and follows it, which is what a single resizable pane wants. `fixed`
 * pins the grid, which is what a wall of them needs: a tile that re-fits would renegotiate the
 * PTY size on every layout change.
 *
 * A TMUX target ignores this entirely and renders at the pane's own geometry, whichever is asked
 * for. tmux has one window size per session, so a viewer that imposed its grid reflowed the
 * session in its owner's terminal; and a viewer that merely rendered at the wrong grid painted an
 * absolutely-addressed screen into the wrong rows, so text landed a row off from where the screen
 * said it was. Both were measured on a live Claude Code pane. A terminal that is entirely BLANK is
 * a different fault -- its event stream never opened -- and `openTerminalStream` says so now.
 */
export type TerminalSizing =
  | { kind: "fit" }
  | { kind: "fixed"; columns: number; rows: number };

/** What the terminal knows about itself that is worth showing next to it. */
export interface TerminalLabels {
  sync: string;
  ownership: string;
  source: string;
  view: string;
}

export interface Dimensions {
  columns: number;
  rows: number;
}
