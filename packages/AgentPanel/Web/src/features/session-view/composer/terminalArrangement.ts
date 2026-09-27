import type { SessionTmuxTerminalContext } from "@agentdesk/agent-feed-wire";

/**
 * Whether the composer band puts a pane above its field, given what this session remembers.
 *
 * Its own module for one reason: the answer depends on something the caller can forget, and
 * forgetting it is not a visible mistake until a card is on screen. See `hasBasis`.
 *
 * The pane is a PEEK rather than a place to work -- it opens at the minimum a pane can be, and
 * keeps the bottom of the screen in view, because the line a reader is watching for their own text
 * is the last one. That is what makes it affordable to show at the same time as the field. Showing
 * both used to mean stacking two full-height input surfaces, which spent two thirds of the band on
 * input and left 267 of a card's 640 pixels for the transcript the two are about.
 */

/**
 * `hasBasis` is not a detail: a band pane cannot measure its own parent, so one mounted before its
 * height reference exists opens at a share of the VIEWPORT, which inside a card is more than the
 * whole card and squeezes the transcript away. No basis means no pane.
 */
export function terminalArrangement(shown: boolean, hasBasis: boolean): "echo" | null {
  return shown && hasBasis ? "echo" : null;
}

export interface ComposerTerminalPane {
  context: SessionTmuxTerminalContext;
  layout: "band" | "echo";
  height: number | null;
  onResized: (height: number) => void;
}

/**
 * The pane that stands above the field, in the band's own shape, or null when this session's is
 * hidden. Beside `terminalArrangement` because it is the same decision with the session's
 * remembered size attached: the field is not part of it, since it is the surface every session
 * has, and the control is about what is ABOVE it rather than about which of two surfaces gets
 * the band.
 */
export function composerTerminalPane(
  terminalComposer: {
    context: SessionTmuxTerminalContext;
    shown: boolean;
    height: number | null;
    onResized: (height: number) => void;
  } | null,
  terminalHeightBasis: HTMLElement | null,
): ComposerTerminalPane | null {
  const layout = terminalArrangement(
    Boolean(terminalComposer?.shown),
    Boolean(terminalHeightBasis),
  );
  if (!terminalComposer || !layout) return null;
  const { context, height, onResized } = terminalComposer;
  return { context, layout, height, onResized };
}
