/**
 * Whether this browser raises a software keyboard when a field takes focus.
 *
 * Two surfaces ask it and mean slightly different things by the answer. The desktop viewer asks
 * whether it must DRAW a keyboard rather than focus anything, because a phone's own keyboard
 * cannot send the Mac a Cmd. The terminal asks whether the keyboard about to appear is missing
 * Esc, Tab, Ctrl and the arrows, and so needs a rail beside it. Both reduce to: is there a
 * physical keyboard here, or is one about to be drawn over half the screen.
 *
 * `(hover: none) and (pointer: coarse)` is the pair, rather than a user-agent string: it is asking
 * about the input device, which is the thing that actually decides.
 */
export function drawsOwnKeyboard(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}
