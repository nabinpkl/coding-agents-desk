// A quick look into a Bot's code: its files on one side, the chosen one on the other.
//
// Both halves are the IDE's -- its explorer tree, and the file body its editor pane draws with,
// source or rendered -- so a file reads the same here as it does there. What differs is that this
// only reads: it is for finding your way around what a Bot is working on, and the IDE is where
// its files are changed.
//
// Side by side where there is room; on a phone, one at a time, with the tree first and a way back
// from the file.

import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import type { BotView } from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useBotCode } from "@/features/bots/code/useBotCode";
import { BACK_TO_LIST, BotWideDialog } from "@/features/bots/dialogs/BotWideDialog";
import { defaultFileView, FileBody, FileViewToggle } from "@/features/workspace-ide/editor/FileBody";
import { WorkspaceTree } from "@/features/workspace-ide/sidebar/WorkspaceTree";

export function BotCodeDialog({
  bot,
  feed,
  refresh,
  onClose,
}: {
  bot: BotView;
  feed: SidecarDataSource;
  /** Anything that moves when the Bot's files do; see `useBotCode`. */
  refresh: unknown;
  onClose: () => void;
}) {
  const code = useBotCode(feed, bot.botId, refresh);
  const { file, openPath } = code;
  // The reader's choice for each file this look, falling back to the kind's own default. Only
  // markdown has two views worth offering here: the IDE's preview of any other source kind is the
  // same text without its line numbers.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const preview = file
    ? chosen[file.path] ?? defaultFileView(file.kind) === "preview"
    : false;

  return (
    <BotWideDialog
      titleId="bot-code-title"
      title={`Code in ${bot.name}`}
      subtitle={<span className="font-mono">{bot.environment.path}</span>}
      closeLabel="Close code"
      error={code.error}
      onClose={onClose}
    >
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(14rem,20rem)_1fr]">
        <nav
          aria-label="Files"
          className={`min-h-0 overflow-auto p-1.5 text-sm md:block md:border-r md:border-border
            ${openPath ? "hidden" : ""}`}
        >
          {code.tree === null ? (
            <p className="m-0 p-2 text-muted-foreground">Listing files…</p>
          ) : code.tree.length === 0 ? (
            <p className="m-0 p-2 text-muted-foreground">This directory is empty.</p>
          ) : (
            <WorkspaceTree
              nodes={code.tree}
              activePath={openPath}
              onOpen={code.open}
              onToggle={code.toggle}
            />
          )}
        </nav>
        <section
          aria-label="File"
          className={`min-h-0 flex-col md:flex ${openPath ? "flex" : "hidden"}`}
        >
          {openPath ? (
            <>
              <div className="flex shrink-0 items-center gap-1 border-b border-border px-1 py-1">
                <button
                  type="button"
                  onClick={code.close}
                  aria-label="Back to the files"
                  className={BACK_TO_LIST}
                >
                  <ArrowLeft className="size-4" aria-hidden />
                </button>
                <span className="min-w-0 flex-1 truncate px-1 font-mono text-xs" title={openPath}>
                  {openPath}
                </span>
                {file?.kind === "markdown" ? (
                  <FileViewToggle
                    preview={preview}
                    editable={false}
                    onToggle={() => setChosen((current) => ({ ...current, [file.path]: !preview }))}
                  />
                ) : null}
              </div>
              <div className="relative min-h-0 flex-1 overflow-hidden">
                {file ? (
                  <FileBody file={file} preview={preview} />
                ) : (
                  <p className="m-0 p-6 text-center text-sm text-muted-foreground">Opening file…</p>
                )}
              </div>
            </>
          ) : (
            <p className="m-auto p-6 text-center text-sm text-muted-foreground">
              Choose a file to read it.
            </p>
          )}
        </section>
      </div>
    </BotWideDialog>
  );
}
