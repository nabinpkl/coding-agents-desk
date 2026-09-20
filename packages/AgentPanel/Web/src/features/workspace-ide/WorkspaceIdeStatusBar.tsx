// The IDE's bottom bar: what stays true whichever pane is hidden.
//
// Both items were somewhere else and neither could be relied on. The branch sat in the sidebar's
// section nav, which vanishes with the sidebar; the terminal toggle sat in the editor toolbar,
// three controls away from the pane it opens and above it rather than at its edge. A status bar
// is the one strip of an IDE that is always on screen, so it is where a fact a reader should not
// have to go looking for belongs -- and where the control for a pane that is currently closed
// belongs, because the pane itself cannot carry it.
//
// Three items, all at the left end, and each one is about the repository or a way into it: what
// branch this is, a shell in it, and what has already landed on it. A status bar fills up with
// whatever nobody found a home for, and every addition costs the others their glanceability -- the
// empty right end is the reminder of that rather than space waiting to be used.

import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { GitBranch, History, SquareTerminal } from "lucide-react";
import type { WorkspaceCommit, WorkspaceCommitFile, WorkspaceGitStatus } from "@agentdesk/agent-feed-wire";
import type { CommitDiffTarget } from "@/features/workspace-ide/history/CommitDiff";
import { useCommitHistory } from "@/features/workspace-ide/history/useCommitHistory";
import { WorkspaceIdeHistory } from "@/features/workspace-ide/history/WorkspaceIdeHistory";
import type { WorkspaceIdeClient } from "@/features/workspace-ide/workspaceIdeClient";
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
  client,
  workspaceId,
  terminalVisible,
  editor,
  showingDiff,
  onOpenDiff,
  onShowSourceControl,
  onToggleTerminal,
}: {
  git: WorkspaceGitStatus | null;
  /** The history popup reads its own three levels, so it is handed the client rather than data. */
  client: WorkspaceIdeClient;
  workspaceId: string | null;
  terminalVisible: boolean;
  /** The editor pane, which counts as inside the history for the purpose of dismissing it. */
  editor: RefObject<HTMLElement | null>;
  /** What the editor's diff tab is showing, so the history marks the row that put it there. */
  showingDiff: CommitDiffTarget | null;
  /** Opens one file of one commit in the editor, which is what clicking a history row does. */
  onOpenDiff: (commit: WorkspaceCommit, file: WorkspaceCommitFile) => void;
  /** Reveals the sidebar on its source-control section, which is where the count resolves. */
  onShowSourceControl: () => void;
  onToggleTerminal: () => void;
}) {
  const changed = changedFileCount(git?.entries ?? []);
  const historyId = useId();
  const historyTrigger = useRef<HTMLButtonElement | null>(null);
  const bar = useRef<HTMLElement | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Opened once, and the log is kept from then on. The history's state sits here rather than in
  // the popup because the popup unmounts every time it is dismissed; `useCommitHistory` says why.
  // Until the first open there is nothing to read, so a reader who never asks for the history never
  // pays a `git log` for it.
  const [everOpened, setEverOpened] = useState(false);
  const history = useCommitHistory(client, workspaceId, everOpened);

  /** Close, and put focus back where it was, because a keyboard reader is standing on that button. */
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    historyTrigger.current?.focus();
  }, []);

  // Escape, and a pointer landing anywhere that is neither this bar nor the editor.
  //
  // The editor counts as inside because it is where what the history opened is READ: closing the
  // diff's tab, scrolling the patch, going to a file tab and back are all part of reading one
  // commit, and a panel that dismissed itself on any of them would have to be reopened, scrolled
  // and re-expanded between every file. What does close it is a pointer going somewhere else to
  // work -- the sidebar, the terminal, the roster -- which is a reader saying they are done
  // looking back.
  //
  // On `pointerdown` rather than `click`: a click that starts inside the popup and ends outside it
  // -- selecting a line of a diff and releasing past the edge -- is not a click elsewhere.
  useEffect(() => {
    if (!historyOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeHistory();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      const within = (region: HTMLElement | null) =>
        target instanceof Node && region !== null && region.contains(target);
      if (within(bar.current) || within(editor.current)) return;
      // No focus returned here, unlike Escape: the pointer has already put focus where it landed,
      // and taking it back to the bar would move the reader away from what they just clicked.
      setHistoryOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [historyOpen, closeHistory, editor]);
  // No branch means either a directory git does not track or a detached HEAD: `branch
  // --show-current` answers empty for both, so there is nothing honest to print. An item that
  // said "no branch" over a plain directory would be reporting on git rather than on the project.
  const branch = git?.branch ?? null;

  return (
    <footer
      ref={bar}
      aria-label="Workspace status"
      // One file-tree row tall, 32px, with type one step under the panel's 16px body rather than
      // the two steps a status bar usually takes. The usual ratio is set against a 13px UI; this
      // panel's body is 16px because it is read on a phone, so 11px beside it was not dense, it
      // was shorter than a single tree row and the eye took the whole bar for a border.
      //
      // Still under the 44px touch minimum, knowingly. Every control on this surface is, and a
      // bar sized for a thumb would take a row of the editor on the phone, which can least
      // spare one.
      //
      // `relative` so the history popup rises from this strip and is anchored to its left end,
      // where the control that opens it sits. Not clipped by anything between here and the page,
      // so the popup overlays the editor rather than being cut off at the top of the bar.
      className="relative flex h-8 shrink-0 items-center border-t border-border bg-muted/40 text-sm"
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
        // Beside the branch rather than opposite it. The two are one group -- what this project
        // is, and a way into it -- and a control alone at the far end of a 1500px bar is a long
        // way from the eye that has just read the branch. Padded wider than the branch item
        // because it is the one target here with no text to aim at.
        className={`${ITEM} px-3`}
      >
        <SquareTerminal aria-hidden className="size-4" />
      </button>

      {/* After the terminal, and the same size as it: a way INTO the repository followed by a way
          BACK through it. It opens no pane, so unlike the terminal toggle it is pressed only while
          its popup is up. */}
      <button
        type="button"
        ref={historyTrigger}
        aria-label="Show git history"
        aria-expanded={historyOpen}
        aria-controls={historyOpen ? historyId : undefined}
        aria-pressed={historyOpen}
        title="History"
        onClick={() => {
          if (historyOpen) return closeHistory();
          setEverOpened(true);
          setHistoryOpen(true);
        }}
        className={`${ITEM} px-3`}
      >
        <History aria-hidden className="size-4" />
      </button>

      {/* Nothing to read the history of until a workspace is chosen, so the popup is not rendered
          rather than rendered empty: the roster is what the reader has to answer first. */}
      {historyOpen && workspaceId !== null
        ? (
          <WorkspaceIdeHistory
            id={historyId}
            history={history}
            showing={showingDiff}
            onOpenDiff={onOpenDiff}
            onClose={closeHistory}
          />
        )
        : null}
    </footer>
  );
}
