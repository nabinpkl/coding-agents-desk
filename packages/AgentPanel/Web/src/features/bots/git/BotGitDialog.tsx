// A Bot's uncommitted changes: the files on one side, the chosen file's diff on the other.
//
// Both halves are the IDE's. The list is its source-control section and the diff is the renderer
// its commit history draws with, so a change reads the same wherever a reader meets it. What is
// the Bot's own is only where the answers come from: its directory, on its machine.
//
// Side by side where there is room for a diff beside a list; on a phone, one at a time, with the
// list first and a way back from the diff.

import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import type { BotGitStatus, BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { BACK_TO_LIST, BotWideDialog } from "@/features/bots/dialogs/BotWideDialog";
import { ReadPatchView } from "@/features/workspace-ide/history/PatchView";
import { SourceControl } from "@/features/workspace-ide/sidebar/SourceControl";
import { changedFileCount, changedLabel } from "@/features/workspace-ide/sidebar/gitTones";

export function BotGitDialog({
  bot,
  feed,
  status,
  error,
  onClose,
}: {
  bot: BotView;
  feed: SidecarDataSource;
  status: BotGitStatus;
  /** Why the status stream failed, shown over a list that may be out of date because of it. */
  error: string | null;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  // A file committed or reverted while it was open is no longer a change, and asking for its diff
  // would answer a 404 about a file the reader can see is gone from the list.
  const paths = status.entries.map((entry) => entry.relativePath);
  const stillChanged = selected !== null && paths.includes(selected);
  useEffect(() => {
    if (selected !== null && !stillChanged) setSelected(null);
  }, [selected, stillChanged]);

  const count = changedFileCount(status.entries);

  return (
    <BotWideDialog
      titleId="bot-git-title"
      title={`Changes in ${bot.name}`}
      subtitle={(
        <>
          {status.branch ? <span className="font-mono">{status.branch}</span> : "No branch"}
          {" · "}
          {changedLabel(count)}
        </>
      )}
      closeLabel="Close changes"
      error={error}
      onClose={onClose}
    >
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(14rem,20rem)_1fr]">
        <nav
          aria-label="Changed files"
          className={`min-h-0 overflow-auto p-1.5 text-sm md:block md:border-r md:border-border
            ${stillChanged ? "hidden" : ""}`}
        >
          <SourceControl entries={status.entries} onOpen={setSelected} selectedPath={selected} />
        </nav>
        <section
          aria-label="Diff"
          className={`min-h-0 flex-col md:flex ${stillChanged ? "flex" : "hidden"}`}
        >
          {stillChanged ? (
            <>
              <div className="flex shrink-0 items-center gap-1 border-b border-border px-1 py-1">
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  aria-label="Back to the changed files"
                  className={BACK_TO_LIST}
                >
                  <ArrowLeft className="size-4" aria-hidden />
                </button>
                <span className="min-w-0 truncate px-1 font-mono text-xs" title={selected}>
                  {selected}
                </span>
              </div>
              <div className="min-h-0 flex-1">
                {/* Re-read on each pushed status, because an agent on this Bot may be mid-edit. */}
                <ReadPatchView
                  subject={`${bot.botId}:${selected}`}
                  refresh={status}
                  read={() => feed.botGitDiff(bot.botId, selected)}
                />
              </div>
            </>
          ) : count > 0 ? (
            <p className="m-auto p-6 text-center text-sm text-muted-foreground">
              Choose a file to see its diff.
            </p>
          ) : null}
        </section>
      </div>
    </BotWideDialog>
  );
}
