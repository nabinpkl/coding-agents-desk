// A run's judge: a switch in the run's header, and while the reader has it open, a window floating
// over the lanes' corner holding the judge's whole session.
//
// The judge is an ordinary session in a terminal, so the window is the same `SessionView` a lane
// renders -- transcript, controls, the pane over the composer -- and the reader asks it for a
// verdict by typing into it. It floats rather than taking a lane because it is not a contestant:
// it reads the lanes, and a column beside them would take width every lane needs. It starts put
// away, with only its switch in the header, so it never covers a lane the reader did not open it over.
//
// The session is shown from the moment the judge has a pane, before the catalog lists it (Claude
// writes no transcript until its first turn), the way a contestant's lane is.

import { useCallback, useMemo, useState } from "react";
import { ChevronDown, Scale } from "lucide-react";
import type { ArenaJudgeSummary } from "@agentdesk/agent-feed-wire";
import { SessionView, type SessionViewContext } from "@/features/session-view/SessionView";
import { FileDropOverlay, useFileDropTarget } from "@/features/session-view/fileDropTarget";
import { awaitedSession, type ListedSession } from "@/features/arena/ArenaSessionLanes";
import { FOCUS, ICON_BUTTON, SOURCE_LABEL, TEXT } from "@/features/arena/arenaVocabulary";

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
      title={`${open ? "Put the judge away" : "Open the judge"} (${SOURCE_LABEL[judge.source]}, ${STATUS_LINE[judge.status]})`}
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
    // Fixed, so it is placed against the layout viewport, which a phone keyboard does not shorten:
    // it rises by the keyboard's inset itself, as the document does.
    <section
      id="arena-judge"
      aria-label="Judge"
      className="fixed right-4 bottom-[calc(1rem+var(--agent-panel-keyboard-inset,0px))] z-40 flex h-[min(40rem,calc(100dvh-6rem-var(--agent-panel-keyboard-inset,0px)))] w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      {...drop.dropProps}
    >
      {/* Wraps rather than clips: on a phone the session's controls take a second row. */}
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border py-1 pr-1 pl-3">
        <Scale aria-hidden className="size-4 shrink-0" />
        <h2 className={`shrink-0 ${TEXT.title} font-semibold text-foreground`}>{label}</h2>
        {/* The session's own controls (mode, terminal) portal into this row. */}
        <span ref={setControlsHost} className="ml-auto flex flex-wrap items-center gap-1" />
        <button
          type="button"
          onClick={onClose}
          aria-expanded
          aria-controls="arena-judge"
          aria-label="Put the judge away"
          title="Put the judge away"
          className={ICON_BUTTON}
        >
          <ChevronDown aria-hidden className="size-4" />
        </button>
      </header>
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
    </section>
  );
}
