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
 * Scrolling stops at zero, so a pane taller than the drawn rows shows the blank rows under them.
 * It never grows past the whole screen (`wholeScreen` in `AgentTerminalPane`), so that is a few
 * rows at most. Lowering the screen with a margin instead was tried and dropped: the margin went
 * stale whenever the screen reflowed without this re-running, and once left it below the pane.
 */
export function keepLastDrawnRowInView(mount: HTMLElement, lastDrawnRow: number | null): void {
  const row = lastDrawnRow === null ? null : mount.querySelector(".xterm-rows")?.children[lastDrawnRow];
  if (!row) {
    mount.scrollTop = mount.scrollHeight;
    return;
  }
  const bottom = row.getBoundingClientRect().bottom - mount.getBoundingClientRect().top + mount.scrollTop;
  mount.scrollTop = Math.max(0, bottom - mount.clientHeight);
}
