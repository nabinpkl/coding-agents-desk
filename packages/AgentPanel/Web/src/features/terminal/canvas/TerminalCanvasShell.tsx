// The terminal canvas as a surface: the roster beside the strip.
//
// `TerminalCanvas` is handed everything and owns nothing, so it can be tested against fixed
// props. This is the component that knows where the answers come from: the snapshots, the
// roster, the stored arrangement and the two commands, all in `useTerminalCanvas`. The sidebar
// is the same roster stood vertically -- every parent with its children, the machine chips, and
// the hide/kill controls the cards carry -- the way the Bot canvas pairs its strip with the
// Canvas tab's roster. One is never a lesser copy of the other: both read the shell's sets, so
// a row and its card cannot disagree about what is hidden, off the strip, or open.

import { useState } from "react";
import { PanelLeft } from "lucide-react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { BotMachine } from "@/features/bots/botMachines";
import { TerminalCanvas } from "@/features/terminal/canvas/TerminalCanvas";
import { TerminalSidebarPanel } from "@/features/terminal/canvas/TerminalSidebarPanel";
import { useTerminalCanvas } from "@/features/terminal/canvas/useTerminalCanvas";

export function TerminalCanvasShell({
  feed,
  machines,
}: {
  /** The sidecar this shell is pointed at, home when the embedder names no machines. */
  feed: SidecarDataSource;
  /** Every machine the embedder can reach, or absent for one that reaches only its own. */
  machines: readonly BotMachine[] | undefined;
}) {
  const shell = useTerminalCanvas(feed, machines);
  // Beside the strip on a wide surface, a drawer over it on a phone: the aside is `static`
  // from `sm` up and an overlay below it, and the backdrop only exists where the overlay does.
  // Remembered nowhere -- the arrangement (hidden parents, open children) is what persists,
  // and the list being open is chrome, which the sidebar's own open state already covers
  // on the feed surface.
  const [listOpen, setListOpen] = useState(true);
  return (
    <div className="relative flex h-full min-h-0">
      {listOpen ? (
        // Pointer-only: the panel's own close button is the keyboard path, this only dismisses
        // the overlay where it exists.
        <div
          aria-hidden
          onClick={() => setListOpen(false)}
          className="absolute inset-0 z-10 bg-black/40 sm:hidden"
        />
      ) : null}
      {listOpen ? (
        <aside
          aria-label="Terminal list"
          className="absolute inset-y-0 left-0 z-20 flex w-[min(88vw,288px)] shrink-0 flex-col border-r border-border bg-card sm:static sm:w-72"
        >
          <TerminalSidebarPanel
            grouping={shell.grouping}
            hues={shell.hues}
            loading={shell.loading}
            error={shell.error}
            machineErrors={shell.machineErrors}
            machines={shell.machines}
            hiddenMachines={shell.hiddenMachines}
            onToggleMachine={shell.onToggleMachine}
            hiddenParents={shell.hiddenParents}
            onHideParent={shell.onHideParent}
            onShowParent={shell.onShowParent}
            offStripChildren={shell.offStripChildren}
            openChildren={shell.openChildren}
            onSelectChild={shell.onSelectChild}
            onHideChild={shell.onHideChild}
            onKillChild={shell.onKillChild}
            onAddTerminal={shell.onAddTerminal}
            addingKeys={shell.addingKeys}
            addErrors={shell.addErrors}
            onDismissAddError={shell.onDismissAddError}
            onRefresh={shell.onRefresh}
            onClose={() => setListOpen(false)}
          />
        </aside>
      ) : (
        // The way back when the list is closed: a slim rail rather than a bar, so closing the
        // list gives the strip nearly the whole width back instead of trading one chrome for
        // another.
        <button
          type="button"
          onClick={() => setListOpen(true)}
          aria-label="Show terminal list"
          title="Show terminal list"
          className="flex w-10 shrink-0 cursor-pointer flex-col items-center border-r border-border bg-card py-3 text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset active:bg-muted/80"
        >
          <PanelLeft className="size-5" aria-hidden />
        </button>
      )}
      <div className="min-h-0 min-w-0 flex-1">
        <TerminalCanvas
          grouping={shell.grouping}
          hues={shell.hues}
          loading={shell.loading}
          error={shell.error}
          machineErrors={shell.machineErrors}
          machines={shell.machines}
          hiddenMachines={shell.hiddenMachines}
          onToggleMachine={shell.onToggleMachine}
          feedFor={shell.feedFor}
          hiddenParents={shell.hiddenParents}
          onHideParent={shell.onHideParent}
          onShowParent={shell.onShowParent}
          offStripChildren={shell.offStripChildren}
          onHideChild={shell.onHideChild}
          onShowHiddenChildren={shell.onShowHiddenChildren}
          openChildren={shell.openChildren}
          onToggleChild={shell.onToggleChild}
          onKillChild={shell.onKillChild}
          addingKeys={shell.addingKeys}
          addErrors={shell.addErrors}
          onAddTerminal={shell.onAddTerminal}
          onDismissAddError={shell.onDismissAddError}
          orphanedError={null}
          onRefresh={shell.onRefresh}
        />
      </div>
    </div>
  );
}
