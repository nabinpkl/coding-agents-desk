// The Father home, standing over the whole site.
//
// Mounted once beside the surfaces rather than inside one: the bar's switch opens it over the
// desktop, the terminals, the IDE -- anywhere -- because its pipeline reads the bot records
// themselves rather than anything the canvas arranged. The drawer is `fixed` and hangs from below
// that switch on any tab, leaving the bar's own controls reachable; the tasks node beside it is
// the session's own, so its background-tasks panel positions against the home rather than a
// surface.

import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import type { BotMachine } from "@/features/bots/botMachines";
import { FatherOverlay } from "@/features/bots/canvas/FatherOverlay";
import { useFatherScope } from "@/features/bots/father/useFatherScope";

export function FatherScope({
  feed,
  host,
  machines,
  open,
  onClose,
}: {
  /** The panel's own sidecar: the default every answer below falls back to. */
  feed: SidecarDataSource;
  host: HostActionsClient;
  /** Every sidecar the home reads records from, home first. */
  machines: readonly BotMachine[];
  open: boolean;
  onClose: () => void;
}) {
  const scope = useFatherScope({ feed, host, machines });
  // Shut is shut, and loading with nothing yet is not a home that names nothing: the overlay
  // would say how to name one before the records have even arrived.
  if (!open || (scope.loading && scope.bots.length === 0)) return null;
  return (
    <>
      <FatherOverlay
        bots={scope.bots}
        sessionContextFor={scope.sessionContextFor}
        attachSessionToBot={scope.attachSessionToBot}
        onDetachSession={scope.onDetachSession}
        botError={scope.botError}
        onClose={onClose}
      />
      {/* `contents` so this box is not one: the panel inside it positions against the home. */}
      <div ref={scope.setTasksHost} className="contents" />
    </>
  );
}
