// The IDE's bottom bar: what stays true whichever pane is hidden.
//
// Both items were somewhere else and neither could be relied on. The branch sat in the sidebar's
// section nav, which vanishes with the sidebar; the terminal toggle sat in the editor toolbar,
// three controls away from the pane it opens and above it rather than at its edge. A status bar
// is the one strip of an IDE that is always on screen, so it is where a fact a reader should not
// have to go looking for belongs -- and where the control for a pane that is currently closed
// belongs, because the pane itself cannot carry it.
//
// Deliberately two items. A status bar fills up with whatever nobody found a home for, and every
// addition costs the two that are here their glanceability.

import { GitBranch, SquareTerminal } from "lucide-react";
import type { WorkspaceGitStatus } from "@agentdesk/agent-feed-wire";
import { changedFileCount, changedLabel } from "@/features/workspace-ide/sidebar/gitTones";

// No horizontal padding here: each item sets its own, and two `px-*` on one element would be
// decided by the order Tailwind happens to emit them in rather than by the order written.
const ITEM = "flex h-full shrink-0 items-center gap-1.5 text-muted-foreground outline-none"
  + " transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2"
  + " focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/70"
  + " aria-pressed:bg-muted aria-pressed:text-foreground";

/**
 * What the reader sees first, then what the click does.
 *
 * The count is in the name because the pill carrying it is a glyph to everything but the eye, the
 * same reason the sidebar's section tab spells it out. Leading with the branch rather than the
 * action so this is not a second button named "Show Source Control", which is that tab's.
 */
function branchLabel(branch: string, changed: number): string {
  const action = "Show Source Control";
  return changed > 0 ? `${branch}, ${changedLabel(changed)}. ${action}` : `${branch}. ${action}`;
}

export function WorkspaceIdeStatusBar({
  git,
  terminalVisible,
  onShowSourceControl,
  onToggleTerminal,
}: {
  git: WorkspaceGitStatus | null;
  terminalVisible: boolean;
  /** Reveals the sidebar on its source-control section, which is where the count resolves. */
  onShowSourceControl: () => void;
  onToggleTerminal: () => void;
}) {
  const changed = changedFileCount(git?.entries ?? []);
  // No branch means either a directory git does not track or a detached HEAD: `branch
  // --show-current` answers empty for both, so there is nothing honest to print. An item that
  // said "no branch" over a plain directory would be reporting on git rather than on the project.
  const branch = git?.branch ?? null;

  return (
    <footer
      aria-label="Workspace status"
      // One file-tree row tall, 32px, with type one step under the panel's 16px body rather than
      // the two steps a status bar usually takes. The usual ratio is set against a 13px UI; this
      // panel's body is 16px because it is read on a phone, so 11px beside it was not dense, it
      // was shorter than a single tree row and the eye took the whole bar for a border.
      //
      // Still under the 44px touch minimum, knowingly. Every control on this surface is, and a
      // bar sized for a thumb would take a row of the editor on the phone, which can least
      // spare one.
      className="flex h-8 shrink-0 items-center border-t border-border bg-muted/40 text-sm"
    >
      {branch !== null
        ? (
          <button
            type="button"
            aria-label={branchLabel(branch, changed)}
            title={branchLabel(branch, changed)}
            onClick={onShowSourceControl}
            className={`${ITEM} px-2`}
          >
            <GitBranch aria-hidden className="size-4" />
            {/* Full ink and monospace: the branch is the one thing on this bar a reader came to
                read, and it is an identifier they may need to type back somewhere. Capped in
                characters rather than pixels so a long branch truncates at the same place in
                every theme, and so the terminal toggle keeps its corner on a phone. */}
            <span className="max-w-[20ch] truncate font-mono text-foreground">{branch}</span>
            {/* Recessed rather than tinted. It annotates the branch, and the Source Control tab
                is already carrying this number in primary as the thing to go and act on. */}
            {changed > 0
              ? (
                <span
                  aria-hidden
                  className="min-w-[20px] rounded-full bg-background px-1.5 text-center font-mono
                    text-xs leading-[19px]"
                >
                  {changed > 99 ? "99+" : changed}
                </span>
              )
              : null}
          </button>
        )
        : null}

      <button
        type="button"
        aria-label="Toggle terminal"
        aria-pressed={terminalVisible}
        title="Terminal"
        onClick={onToggleTerminal}
        // Wider than the branch item is padded: it is the one target here with no text to
        // aim at, and the corner is where a thumb lands.
        className={`${ITEM} ml-auto px-3`}
      >
        <SquareTerminal aria-hidden className="size-4" />
      </button>
    </footer>
  );
}
