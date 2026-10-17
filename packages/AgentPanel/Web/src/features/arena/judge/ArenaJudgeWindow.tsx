// A run's judge: a switch in the run's header, and while the reader has it open, a window hanging
// below that switch holding the judge's whole session.
//
// The judge is an ordinary session in a terminal, so the window is the same `SessionView` a lane
// renders -- transcript, controls, the pane over the composer -- and the reader asks it for a
// verdict by typing into it. It floats rather than taking a lane because it is not a contestant:
// it reads the lanes, and a column beside them would take width every lane needs. It is the same
// floating window the Father home is (`FloatingWindow`): carried by its header, resized by its
// edges, remembered where the reader left it. Unlike the home, it stays open while the reader
// works in the lanes -- comparing them is what it is open beside -- and Escape belongs to its
// pane, where it interrupts the judge rather than closing the window.
//
// The session is shown from the moment the judge has a pane, before the catalog lists it (Claude
// writes no transcript until its first turn), the way a contestant's lane is.

import { useCallback, useMemo, useState } from "react";
import { Scale } from "lucide-react";
import type { ArenaJudgeSummary } from "@agentdesk/agent-feed-wire";
import { SessionView, type SessionViewContext } from "@/features/session-view/SessionView";
import { FileDropOverlay, useFileDropTarget } from "@/features/session-view/fileDropTarget";
import { awaitedSession, type ListedSession } from "@/features/arena/ArenaSessionLanes";
import { FOCUS, SOURCE_LABEL, TEXT } from "@/features/arena/arenaVocabulary";
import { FloatingWindow } from "@/features/floating-window/FloatingWindow";
import { floatingWindowPreferences } from "@/features/floating-window/floatingWindowPreferences";

/** One judge window size and place for every run: a reader sets it up once, where it suits them. */
const JUDGE_WINDOW = floatingWindowPreferences("agent-panel.arena.judge", {
  width: { min: 360, max: 1200, default: 640 },
  height: { min: 240, max: 900, default: 560 },
});

const STATUS_LINE: Record<ArenaJudgeSummary["status"], string> = {
  starting: "starting",
  open: "open",
  failed: "failed",
};

/**
 * The switch that opens and puts away the judge, standing in the run's header beside its other
 * controls: put away, the judge takes no room over the lanes at all.
 */
export function JudgeSwitch({ judge, open, onToggle }: {
  judge: ArenaJudgeSummary;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="arena-judge"
      title={`${open ? "Close the judge" : "Open the judge"} (${SOURCE_LABEL[judge.source]}, ${STATUS_LINE[judge.status]})`}
      className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-3 ${TEXT.body} font-medium transition-colors duration-150 hover:bg-muted active:bg-accent ${
        open ? "border-ring bg-muted text-foreground" : "border-border bg-background text-foreground"
      } ${FOCUS}`}
    >
      <Scale aria-hidden className={`size-4 shrink-0 ${judge.status === "failed" ? "text-destructive" : ""}`} />
      Judge
    </button>
  );
}

/** The judge's window, floating over the lanes' corner while the reader has it open. */
export function ArenaJudgeWindow({
  judge,
  listed,
  context,
  onClose,
}: {
  judge: ArenaJudgeSummary;
  /** The judge's session as the catalog lists it, or null until it does. */
  listed: ListedSession | null;
  context: SessionViewContext;
  onClose: () => void;
}) {
  return (
    <OpenJudge judge={judge} listed={listed} context={context} label={`Judge · ${SOURCE_LABEL[judge.source]}`} onClose={onClose} />
  );
}

function OpenJudge({
  judge,
  listed,
  context,
  label,
  onClose,
}: {
  judge: ArenaJudgeSummary;
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
    () => (judge.sessionId !== null && judge.tmuxSession !== null
      ? { session: awaitedSession(judge.source, judge.sessionId, label, null), projectPath: judge.folder }
      : null),
    [judge.sessionId, judge.tmuxSession, judge.source, judge.folder, label],
  );
  const shown = listed ?? awaited;

  return (
    <FloatingWindow
      id="arena-judge"
      label="Judge"
      preferences={JUDGE_WINDOW}
      closeLabel="Close the judge"
      onClose={onClose}
      closeOnEscape={false}
      closeOnOutsidePress={false}
      sectionProps={drop.dropProps}
      header={
        <>
          <Scale aria-hidden className="size-4 shrink-0" />
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
            pane={judge.tmuxSession}
            listed={listed !== null}
          />
          <div ref={setTasksHost} className="contents" />
        </div>
      ) : (
        <p
          role={judge.status === "failed" ? "alert" : undefined}
          className={`px-4 py-6 ${TEXT.body} ${judge.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
        >
          {judge.status === "failed" ? `The judge did not start: ${judge.error ?? "no reason was given"}` : "Starting the judge."}
        </p>
      )}
      <FileDropOverlay
        dragging={drop.dragging}
        refusal={acceptFiles !== null ? null : "The judge has no composer to drop into yet"}
      />
    </FloatingWindow>
  );
}
