/**
 * Keeps the end of a peek's screen in view: its last DRAWN row, at the mount's bottom edge.
 *
 * A peek (an `echo` pane) is usually shorter than the screen it shows, so the screen overflows and
 * the mount scrolls -- and the mount centres what it holds (`m-auto`), which puts a too-tall
 * screen's MIDDLE on screen. The line a peek exists to show is the last one drawn, so it is
 * scrolled to rather than hoped for. That is the screen's bottom row for a program that draws to
 * the bottom, and well above it for Claude Code, whose box sits near the top of a tall pane over
 * blank rows.
 *
 * A pane taller than the drawn rows cannot scroll below zero, so there the screen is LOWERED
 * instead, by a top margin. Without that its top stuck to the pane's, and dragging the pane's
 * handle up carried the text up with it and opened blank rows beneath, which reads as the pane
 * growing the wrong way (measured 2026-10-17: a 120px drag moved the last line 33px up).
 */
export function keepLastDrawnRowInView(mount: HTMLElement, lastDrawnRow: number | null): void {
  const screen = mount.querySelector<HTMLElement>(".xterm");
  // Measured from where the screen sits on its own, so an earlier lowering is not counted twice.
  if (screen) screen.style.marginTop = "";
  const row = lastDrawnRow === null ? null : mount.querySelector(".xterm-rows")?.children[lastDrawnRow];
  if (!row) {
    mount.scrollTop = mount.scrollHeight;
    return;
  }
  const bottom = row.getBoundingClientRect().bottom - mount.getBoundingClientRect().top + mount.scrollTop;
  const overshoot = bottom - mount.clientHeight;
  if (overshoot >= 0 || !screen) {
    mount.scrollTop = Math.max(0, overshoot);
    return;
  }
  screen.style.marginTop = `${(parseFloat(getComputedStyle(screen).marginTop) || 0) - overshoot}px`;
  mount.scrollTop = 0;
}
