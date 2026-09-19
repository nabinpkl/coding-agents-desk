// The terminal canvas as a surface: the shell above the strip.
//
// `TerminalCanvas` is handed everything and owns nothing, so it can be tested against fixed
// props. This is the component that knows where the answers come from: the snapshots, the
// roster, the stored arrangement and the two commands, all in `useTerminalCanvas`.

import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { BotMachine } from "@/features/bots/botMachines";
import { TerminalCanvas } from "@/features/terminal/canvas/TerminalCanvas";
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
  return (
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
  );
}
