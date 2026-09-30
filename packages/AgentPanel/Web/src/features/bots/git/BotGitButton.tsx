// The Bot header's git button: how many files in its directory are uncommitted, and the way in to
// what they are -- the Bot's code modal, opened on its Source Control tab.
//
// Absent where there is no git to speak of -- a missing directory, one outside any repository, or
// before the first answer -- rather than drawn as a zero. A zero says "clean", and a Bot pointed at
// a plain folder is not clean, it has nothing to be clean about. The rules behind that decision, and
// the wording, live in `gitHeaderAction` below rather than here, because a card too narrow for this
// button offers the same action from its more menu and must offer the same one.

import { GitBranch, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { BotCodeDialog } from "@/features/bots/code/BotCodeDialog";
import type { BotGitState } from "@/features/bots/git/useBotGitStatus";
import { changedFileCount, changedLabel } from "@/features/workspace-ide/sidebar/gitTones";

/**
 * What a Bot's directory has to say about git, as one fact rather than a component tree.
 *
 * A pure reading of the subscription, because there are now two places that need it: the button in
 * a card's header row, and the menu entry a card too narrow for that row offers instead. They are
 * the same action with the same wording and the same rules about when it exists, so they are decided
 * once here. The rule that is easiest to get wrong is `absent`: a Bot pointed at a plain folder has
 * nothing to be clean about, and a zero would say it was.
 */
export type BotGitAction =
  /** Nothing has arrived and nothing has failed: the answer is still coming, so draw nothing. */
  | { kind: "unanswered" }
  /** No repository, so no Source Control to show. */
  | { kind: "absent" }
  /** A read that failed with no status to go with it: the button would have nothing to open. */
  | { kind: "unreadable"; error: string }
  | {
      kind: "changes";
      /** Uncommitted files, which the button wears and the menu entry spells out. */
      count: number;
      /** The count in words, or the fact that there is nothing uncommitted. */
      label: string;
      /** Updates stopped after this status. The count is still the last known one. */
      failed: boolean;
    };

export function gitHeaderAction(git: BotGitState): BotGitAction {
  const { status, error } = git;
  if (status === null) {
    return error === null ? { kind: "unanswered" } : { kind: "unreadable", error };
  }
  if (!status.repository) return { kind: "absent" };
  const count = changedFileCount(status.entries);
  return {
    kind: "changes",
    count,
    label: count > 0 ? changedLabel(count) : "No uncommitted changes",
    failed: error !== null,
  };
}

/**
 * The mark a Bot wears when its git cannot be read, rather than a count.
 *
 * Apart from the button because a card too narrow for the button's slot still has to say this: it
 * is information about the Bot rather than a control, and the row can spare a mark even when it
 * cannot spare a control.
 */
export function BotGitUnavailable({ error }: { error: string }) {
  return (
    <span
      role="img"
      aria-label={`Git changes unavailable: ${error}`}
      title={`Git changes unavailable: ${error}`}
      className="flex size-9 shrink-0 items-center justify-center text-destructive"
    >
      <TriangleAlert className="size-4" aria-hidden />
    </span>
  );
}

export function BotGitButton({
  bot,
  feed,
  git,
}: {
  bot: BotView;
  feed: SidecarDataSource;
  /** The card's one subscription, which the code button reads too. */
  git: BotGitState;
}) {
  const action = gitHeaderAction(git);
  const [open, setOpen] = useState(false);

  if (action.kind === "unanswered" || action.kind === "absent") return null;
  // A read that failed with nothing to show yet has no dialog to open, so the mark is the report:
  // the warning and the reason, where the count would have been.
  if (action.kind === "unreadable") return <BotGitUnavailable error={action.error} />;

  const { count, label, failed } = action;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Show git changes in ${bot.name}, ${label}`}
        title={failed ? `${label}. Updates stopped: ${git.error}` : label}
        className={`flex h-9 min-w-9 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg px-1.5 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/70
          ${failed ? "text-destructive" : "text-muted-foreground"}`}
      >
        <GitBranch className="size-4" aria-hidden />
        {count > 0 ? (
          <span aria-hidden className="text-(length:--agent-panel-fs-sidebar-chip,11px) font-medium tabular-nums">
            {count}
          </span>
        ) : null}
      </button>
      {open ? (
        <BotCodeDialog
          bot={bot}
          feed={feed}
          git={git}
          initialSection="sourceControl"
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
