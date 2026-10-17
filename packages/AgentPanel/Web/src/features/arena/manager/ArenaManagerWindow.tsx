// A run's manager: a switch in the run's header, and while the reader has it open, a window hanging
// below that switch holding the manager's whole session.
//
// The manager is an ordinary session in a terminal, so the window is the same `SessionView` a lane
// renders -- transcript, controls, the pane over the composer -- and the reader asks it to plan and
// start the lanes, prompt them, or compare them by typing into it. It floats rather than taking a
// lane because it is not a contestant: it runs and reads the lanes, and a column beside them would
// take width every lane needs. It is the same
// floating window the Father home is (`FloatingWindow`): carried by its header, resized by its
// edges, remembered where the reader left it. Unlike the home, it stays open while the reader
// works in the lanes -- comparing them is what it is open beside -- and Escape belongs to its
// pane, where it interrupts the manager rather than closing the window.
//
// The session is shown from the moment the manager has a pane, before the catalog lists it (Claude
// writes no transcript until its first turn), the way a contestant's lane is.

import { useCallback, useMemo, useState } from "react";
import { UserCog } from "lucide-react";
import type { ArenaManagerSummary } from "@agentdesk/agent-feed-wire";
import { SessionView, type SessionViewContext } from "@/features/session-view/SessionView";
import { FileDropOverlay, useFileDropTarget } from "@/features/session-view/fileDropTarget";
import type { ListedSession } from "@/features/arena/ArenaSessionLanes";
import { awaitedSession } from "@/features/session-view/awaitedSession";
import { FOCUS, SOURCE_LABEL, TEXT } from "@/features/arena/arenaVocabulary";
import { FloatingWindow } from "@/features/floating-window/FloatingWindow";
import { floatingWindowPreferences } from "@/features/floating-window/floatingWindowPreferences";

/** One manager window size and place for every run: a reader sets it up once, where it suits them. */
const MANAGER_WINDOW = floatingWindowPreferences("agent-panel.arena.manager", {
  width: { min: 360, max: 1200, default: 640 },
  height: { min: 240, max: 900, default: 560 },
});

const STATUS_LINE: Record<ArenaManagerSummary["status"], string> = {
  starting: "starting",
  open: "open",
  failed: "failed",
};

/**
 * The switch that opens and puts away the manager, standing in the run's header beside its other
 * controls: put away, the manager takes no room over the lanes at all.
 */
export function ManagerSwitch({ manager, open, onToggle }: {
  manager: ArenaManagerSummary;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="arena-manager"
      title={`${open ? "Close the manager" : "Open the manager"} (${SOURCE_LABEL[manager.source]}, ${STATUS_LINE[manager.status]})`}
      className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 ${TEXT.body} font-medium transition-colors duration-150 hover:bg-muted active:bg-accent ${
        open ? "border-ring bg-muted text-foreground" : "border-border bg-background text-foreground"
      } ${FOCUS}`}
    >
      <UserCog aria-hidden className={`size-4 shrink-0 ${manager.status === "failed" ? "text-destructive" : ""}`} />
      Manager
    </button>
  );
}

/** The manager's window, floating over the lanes' corner while the reader has it open. */
export function ArenaManagerWindow({
  manager,
  listed,
  context,
  onClose,
}: {
  manager: ArenaManagerSummary;
  /** The manager's session as the catalog lists it, or null until it does. */
  listed: ListedSession | null;
  context: SessionViewContext;
  onClose: () => void;
}) {
  return (
    <OpenManager manager={manager} listed={listed} context={context} label={`Manager · ${SOURCE_LABEL[manager.source]}`} onClose={onClose} />
  );
}

function OpenManager({
  manager,
  listed,
  context,
  label,
  onClose,
}: {
  manager: ArenaManagerSummary;
  listed: ListedSession | null;
  context: SessionViewContext;
  label: string;
  onClose: () => void;
}) {
  const [controlsHost, setControlsHost] = useState<HTMLElement | null>(null);
  const [tasksHost, setTasksHost] = useState<HTMLElement | null>(null);
  const [acceptFiles, setAcceptFiles] = useState<((files: readonly File[]) => void) | null>(null);
  // Stable by construction, as `SessionView` requires.
  const takeAcceptFiles = useCallback(
    (accept: ((files: readonly File[]) => void) | null) => setAcceptFiles(() => accept),
    [],
  );
  const drop = useFileDropTarget<HTMLElement>(acceptFiles);
  const awaited = useMemo(
    () => (manager.sessionId !== null && manager.tmuxSession !== null
      ? { session: awaitedSession(manager.source, manager.sessionId, label, null), projectPath: manager.folder }
      : null),
    [manager.sessionId, manager.tmuxSession, manager.source, manager.folder, label],
  );
  const shown = listed ?? awaited;

  return (
    <FloatingWindow
      id="arena-manager"
      label="Manager"
      preferences={MANAGER_WINDOW}
      closeLabel="Close the manager"
      onClose={onClose}
      closeOnEscape={false}
      closeOnOutsidePress={false}
      sectionProps={drop.dropProps}
      header={
        <>
          <UserCog aria-hidden className="size-4 shrink-0" />
          <h2 className={`shrink-0 ${TEXT.title} font-semibold text-foreground`}>{label}</h2>
          {/* The session's own controls (mode, terminal) portal into this row. */}
          <span ref={setControlsHost} className="ml-auto flex flex-wrap items-center gap-1" />
        </>
      }
    >
      {shown ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <SessionView
            key={shown.session.sessionId}
            {...context}
            projectPath={shown.projectPath}
            session={shown.session}
            controlsHost={controlsHost}
            tasksHost={tasksHost}
            onAcceptFiles={takeAcceptFiles}
            pane={manager.tmuxSession}
            listed={listed !== null}
          />
          <div ref={setTasksHost} className="contents" />
        </div>
      ) : (
        <p
          role={manager.status === "failed" ? "alert" : undefined}
          className={`px-4 py-6 ${TEXT.body} ${manager.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {manager.status === "failed" ? `The manager did not start: ${manager.error ?? "no reason was given"}` : "Starting the manager."}
        </p>
      )}
      <FileDropOverlay
        dragging={drop.dragging}
        refusal={acceptFiles !== null ? null : "The manager has no composer to drop into yet"}
      />
    </FloatingWindow>
  );
}
