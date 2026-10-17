// The permission mode a Claude pane is in, read off the status line under its prompt box.
//
// The footer is the only live answer. The transcript rewrites a `permission-mode` record now and
// then rather than when Shift+Tab moves the mode, so a reading of the file can be minutes behind
// the session it describes.

import type { ClaudePermissionMode } from "@agentdesk/agent-feed-wire";
import { plainText } from "@/input/composer/composerBox";

/**
 * What each mode says in the footer, measured 2026-10-09 across the running panes on CLI 2.1.295:
 * `⏵⏵ auto mode on`, `⏵⏵ accept edits on`, `⏸ plan mode on`, `⏵⏵ bypass permissions on`,
 * `⏸ manual mode on`, each followed by ` (shift+tab to cycle)` or ` ·`. `dontAsk` was not seen, so
 * a footer in that mode reads as no answer rather than a guess.
 */
const FOOTER_LABELS: ReadonlyArray<readonly [RegExp, ClaudePermissionMode]> = (
  [
    ["auto mode on", "auto"],
    ["accept edits on", "acceptEdits"],
    ["plan mode on", "plan"],
    ["bypass permissions on", "bypassPermissions"],
    ["manual mode on", "manual"],
  ] as const
).map(([label, mode]) => [new RegExp(`[⏵⏸]+\\s+${label}(?:\\s|$)`), mode] as const);

/** How far up from the bottom the footer can sit: the status rows, a menu below the box at most. */
const FOOTER_ROWS = 8;

/**
 * The mode the footer names, or null when no footer line is on screen.
 *
 * Read from the bottom up and only over the last few rows, because the transcript above the box is
 * the session's own output and can say "plan mode on" in a sentence about something else.
 */
export function permissionModeOn(screen: string): ClaudePermissionMode | null {
  const lines = screen.split("\n");
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - FOOTER_ROWS); index -= 1) {
    const line = plainText(lines[index]!);
    for (const [pattern, mode] of FOOTER_LABELS) {
      if (pattern.test(line)) return mode;
    }
  }
  return null;
}
